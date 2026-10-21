// Plain Sight as a desktop app: the web page (index.html and covers/) in a
// native window.
//
// The shell adds as little as it can. The page and its cover modules are
// served from inside the app under the page's own content security policy
// (tauri.conf.json), the window may show nothing but the app's own page, and
// the page's downloads are saved into the Downloads folder without ever
// overwriting a file. The page has no app commands to call.

// No console window behind the app on Windows release builds (Windows comes later).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::window::Color;
use tauri::{Manager, Runtime, Url, Webview, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // The window is built here rather than in tauri.conf.json so that
            // the handlers below are in place before the page loads.
            let handed_out = Mutex::new(HashSet::new());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Untitled draft")
                .inner_size(1000.0, 760.0)
                .min_inner_size(520.0, 420.0)
                .center()
                .resizable(true)
                // The page's paper colour, so the window does not flash white
                // while the page loads. On macOS this colours the window only,
                // not the web view itself.
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Plain Sight could not start");
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
    let Ok(folder) = webview.path().download_dir() else {
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
        let path = folder.join(name);
        handed_out.contains(&path) || path.symlink_metadata().is_ok()
    };
    let name = free_name(&page_name(proposed, taken), taken);
    let path = folder.join(name);
    if cfg!(debug_assertions) {
        eprintln!("plain-sight: saving a download as {}", path.display());
    }
    handed_out.insert(path.clone());
    *destination = path;
    true
}

/// The page's own rule for a taken name (index.html, folderWrite): " (2)",
/// " (3)" and so on before the extension. Returns the first name that is not
/// taken, so an existing file is never overwritten.
fn free_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_owned();
    }
    let (stem, extension) = match name.rfind('.') {
        Some(dot) if dot > 0 => name.split_at(dot),
        _ => (name, ""),
    };
    let mut n = 2;
    loop {
        let candidate = format!("{stem} ({n}){extension}");
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The name the page asked for. When that name is taken, wry renames it before
/// this app sees it, with its own rule: "<name up to the first dot> (k)<rest>",
/// counting from 1 (wry 0.57.0, src/wkwebview/download.rs lines 62 to 72).
/// This undoes that rename, so that free_name applies the page's rule instead.
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
    fn a_free_name_is_kept() {
        assert_eq!(
            free_name("2026-10-20 14-55-03.txt", |_| false),
            "2026-10-20 14-55-03.txt"
        );
    }

    #[test]
    fn a_taken_name_gets_the_page_counter_before_the_extension() {
        let taken = ["2026-10-20 14-55-03.txt", "2026-10-20 14-55-03 (2).txt"];
        let free = free_name("2026-10-20 14-55-03.txt", |n| taken.contains(&n));
        assert_eq!(free, "2026-10-20 14-55-03 (3).txt");
        let taken = ["untitled-draft-20261020-1455.sight"];
        let free = free_name("untitled-draft-20261020-1455.sight", |n| taken.contains(&n));
        assert_eq!(free, "untitled-draft-20261020-1455 (2).sight");
    }

    #[test]
    fn the_counter_goes_before_the_last_extension_only() {
        assert_eq!(free_name("notes", |n| n == "notes"), "notes (2)");
        assert_eq!(free_name("a.b.txt", |n| n == "a.b.txt"), "a.b (2).txt");
        assert_eq!(free_name(".sight", |n| n == ".sight"), ".sight (2)");
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
        let name = free_name(&page_name("2026-10-20 14-55-03 (1).txt", taken), taken);
        assert_eq!(name, "2026-10-20 14-55-03 (2).txt");
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
