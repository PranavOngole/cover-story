// Plain Sight as a desktop app: the web page (index.html and covers/) in a
// native window.
//
// The shell adds as little as it can. The page and its cover modules are
// served from inside the app under the page's own content security policy
// (tauri.conf.json), the window may show nothing but the app's own page, and
// the page's downloads are saved into the Downloads folder without ever
// overwriting a file. The page can call five app commands through the adapter
// in desktop/adapter.js: four for the folder Save writes into (folder.rs) and
// one to say it is ready to quit (quit.rs). Closing the window and quitting
// both work like Esc first (quit.rs), the window's title follows the page, and
// the menu bar is the app's own (menu.rs).

// No console window behind the app on Windows release builds (Windows comes later).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::window::Color;
use tauri::{Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};

mod folder;
mod menu;
mod quit;

// Test builds only; see the module.
#[cfg(feature = "e2e")]
mod e2e;

/// window.PlainSightNative for the page, built into the app.
const ADAPTER: &str = include_str!("../../adapter.js");

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            folder::pick_folder,
            folder::saved_folder,
            folder::forget_folder,
            folder::write_text_file,
            quit::quit_ready
        ])
        .menu(menu::build)
        .on_menu_event(|app, event| {
            if event.id() == menu::QUIT {
                quit::begin(app);
            }
        })
        // Closing the window quits the app (D-21), after the page's quit hook.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                quit::begin(window.app_handle());
            }
        })
        .setup(|app| {
            quit::install(app.handle());
            app.manage(folder::Folder::load(app.path().app_data_dir().ok()));
            // The window is built here rather than in tauri.conf.json so that
            // the handlers below are in place before the page loads.
            let handed_out = Mutex::new(HashSet::new());
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            #[cfg(target_os = "macos")]
            let builder = match web_view_configuration() {
                Some(configuration) => builder.with_webview_configuration(configuration),
                None => builder,
            };
            builder
                // After Tauri's own scripts, before the page, main frame only.
                .initialization_script(ADAPTER)
                .title("Untitled draft")
                // The title bar names the document on screen, the cover's title (D-20).
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                .inner_size(1000.0, 760.0)
                .min_inner_size(520.0, 420.0)
                .center()
                .resizable(true)
                // The page's paper colour, so the window does not flash white
                // while the page loads: on macOS it colours the window, and wry
                // turns off the web view's own background so it shows through.
                .background_color(Color(0xfb, 0xfa, 0xf7, 0xff))
                .on_navigation(|url| {
                    let allowed = is_app_url(url);
                    if cfg!(debug_assertions) {
                        let verdict = if allowed { "allowed" } else { "refused" };
                        eprintln!("plain-sight: navigation to {url} {verdict}");
                    }
                    allowed
                })
                // Links and scripts may not open other windows.
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_download(move |webview, event| save_download(&webview, event, &handed_out))
                .build()?;
            #[cfg(feature = "e2e")]
            e2e::watch(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Plain Sight could not start");
}

/// The web view's configuration, made here because Apple's Writing Tools can
/// only be turned off before the web view exists (macOS 15 and later); they
/// could otherwise read and rewrite the page's text. writingToolsBehavior is
/// not in objc2-web-kit 0.3.2, so it is set by name, to
/// NSWritingToolsBehaviorNone (-1, AppKit's NSTextCheckingClient.h).
#[cfg(target_os = "macos")]
fn web_view_configuration() -> Option<objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration>> {
    use objc2::{msg_send, sel, MainThreadMarker};
    let mtm = MainThreadMarker::new()?;
    // SAFETY: made on the main thread, as WebKit requires.
    let configuration = unsafe { objc2_web_kit::WKWebViewConfiguration::new(mtm) };
    // SAFETY: the setter takes an NSInteger and is only called where it exists.
    unsafe {
        let has_property: bool =
            msg_send![&configuration, respondsToSelector: sel!(setWritingToolsBehavior:)];
        if has_property {
            let _: () = msg_send![&configuration, setWritingToolsBehavior: -1isize];
        }
    }
    Some(configuration)
}

/// The app's own origin, where the page and its covers are served from. On
/// macOS that is tauri://localhost (Windows uses http://tauri.localhost; that
/// is for a later wave).
fn is_app_url(url: &Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none()
}

/// Save (an encrypted .sight file, or a plain .txt file when no folder is in
/// use) downloads a blob the page made from the text. Only blob downloads are
/// saved; nothing in the page downloads anything else.
fn is_page_download(url: &Url) -> bool {
    url.scheme() == "blob"
}

/// Puts a download in the Downloads folder under the page's own file name,
/// numbered when that name is taken. `handed_out` remembers the paths given
/// out so far, so two quick saves never get the same file even when the first
/// is not on disk yet.
fn save_download<R: Runtime>(
    webview: &Webview<R>,
    event: DownloadEvent<'_>,
    handed_out: &Mutex<HashSet<PathBuf>>,
) -> bool {
    let DownloadEvent::Requested { url, destination } = event else {
        return true; // a download finished; nothing to decide
    };
    if !is_page_download(&url) {
        return false;
    }
    // Refuse rather than fall back to some other folder.
    let Ok(downloads) = webview.path().download_dir() else {
        return false;
    };
    let Some(proposed) = destination.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Ok(mut handed_out) = handed_out.lock() else {
        return false;
    };
    // Taken: handed out earlier, or anything at all on disk under that name.
    let taken = |name: &str| {
        let path = downloads.join(name);
        handed_out.contains(&path) || path.symlink_metadata().is_ok()
    };
    let Some(name) = download_name(proposed, taken) else {
        return false;
    };
    let path = downloads.join(name);
    if cfg!(debug_assertions) {
        eprintln!("plain-sight: saving a download as {}", path.display());
    }
    handed_out.insert(path.clone());
    *destination = path;
    true
}

/// The name a download gets: the page's own name, numbered by the same rule as
/// folder files; None when every name up to (99) is taken.
fn download_name(proposed: &str, taken: impl Fn(&str) -> bool + Copy) -> Option<String> {
    folder::numbered(&page_name(proposed, taken)).find(|name| !taken(name))
}

/// The name the page asked for. When that name is taken, wry renames it before
/// this app sees it, with its own rule: "<name up to the first dot> (k)<rest>",
/// counting from 1 (wry 0.57.0, src/wkwebview/download.rs lines 62 to 72).
/// This undoes that rename, so that the page's rule (folder::numbered) applies.
fn page_name(proposed: &str, taken: impl Fn(&str) -> bool) -> String {
    let (head, rest) = proposed.split_at(proposed.find('.').unwrap_or(proposed.len()));
    if let Some((base, count)) = head.strip_suffix(')').and_then(|h| h.rsplit_once(" (")) {
        let original = format!("{base}{rest}");
        if !count.is_empty() && count.bytes().all(|b| b.is_ascii_digit()) && taken(&original) {
            return original;
        }
    }
    proposed.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_download_keeps_a_free_name_and_numbers_a_taken_one() {
        let name = "untitled-draft-20261020-1455.sight";
        assert_eq!(download_name(name, |_| false).as_deref(), Some(name));
        let taken = [
            "untitled-draft-20261020-1455.sight",
            "untitled-draft-20261020-1455 (2).sight",
        ];
        assert_eq!(
            download_name(name, |n| taken.contains(&n)).as_deref(),
            Some("untitled-draft-20261020-1455 (3).sight")
        );
        assert_eq!(
            download_name(name, |_| true),
            None,
            "refused when every name up to (99) is taken"
        );
    }

    #[test]
    fn wry_renames_are_undone_only_when_the_original_is_taken() {
        let taken = |n: &str| n == "2026-10-20 14-55-03.txt";
        assert_eq!(
            page_name("2026-10-20 14-55-03 (1).txt", taken),
            "2026-10-20 14-55-03.txt"
        );
        assert_eq!(
            page_name("2026-10-20 14-55-03.txt", taken),
            "2026-10-20 14-55-03.txt"
        );
        // A name that merely looks numbered is left alone.
        assert_eq!(page_name("report (1).txt", |_| false), "report (1).txt");
        assert_eq!(page_name("report (x).txt", |_| true), "report (x).txt");
        assert_eq!(page_name("report ().txt", |_| true), "report ().txt");
    }

    #[test]
    fn a_second_save_in_the_same_second_gets_2_not_1() {
        // The first save is on disk; wry proposes " (1)" for the second.
        let taken = |n: &str| n == "2026-10-20 14-55-03.txt";
        let name = download_name("2026-10-20 14-55-03 (1).txt", taken);
        assert_eq!(name.as_deref(), Some("2026-10-20 14-55-03 (2).txt"));
    }

    #[test]
    fn only_the_apps_own_origin_may_be_shown() {
        assert!(is_app_url(&url("tauri://localhost/index.html")));
        assert!(is_app_url(&url("tauri://localhost/covers/book.js")));
        assert!(!is_app_url(&url("https://example.com/")));
        assert!(!is_app_url(&url("http://localhost/")));
        assert!(!is_app_url(&url("tauri://example.com/")));
        assert!(!is_app_url(&url("tauri://localhost:8080/")));
        assert!(!is_app_url(&url("file:///etc/hosts")));
        assert!(!is_app_url(&url("about:blank")));
    }

    #[test]
    fn only_blob_downloads_are_saved() {
        assert!(is_page_download(&url(
            "blob:tauri://localhost/2b1c7d9e-0000-4000-8000-000000000000"
        )));
        assert!(!is_page_download(&url("https://example.com/file.txt")));
        assert!(!is_page_download(&url("data:text/plain,hello")));
        assert!(!is_page_download(&url("tauri://localhost/index.html")));
    }
}
