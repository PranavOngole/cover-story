//! The menu bar, built here in place of Tauri's default. It holds the standard
//! items of a document app and nothing that names what the app really does.
//! Quit is the app's own item, so Cmd+Q runs the page's quit hook before the app
//! ends (quit.rs) without going through a terminate request first. File >
//! Open..., File > Save... and Help > Plain Sight Help press the page's own
//! buttons (D-44): main.rs hands their ids to `press`, which runs `PRESS` in
//! the page.

use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Manager, Runtime};

/// The id of the Quit item; main.rs sends it to quit::begin.
pub const QUIT: &str = "quit";
/// The ids of the items that press a button of the page; `button_for` names
/// the button.
pub const OPEN: &str = "open";
pub const SAVE: &str = "save";
pub const HELP: &str = "help";

/// The page's button an item presses, by the button's id in index.html, or
/// None for an item that presses none.
pub fn button_for(item: &str) -> Option<&'static str> {
    match item {
        OPEN => Some("btn-open"),
        SAVE => Some("btn-save"),
        HELP => Some("btn-help"),
        _ => None,
    }
}

/// What a menu item runs in the page, with BUTTON standing for the button's
/// id: nothing while a dialog is open (the intro or the password dialog), so
/// a shortcut pressed over a dialog changes nothing; otherwise a click on the
/// button, as the mouse would. The click counts as the user's: WebKit runs a
/// script given to `evaluateJavaScript:completionHandler:` with a user
/// gesture (WebKit, `Source/WebKit/UIProcess/API/Cocoa/WKWebView.mm`, that
/// method's call with `forceUserGesture:YES`), and the file panel behind Open
/// needs one (WebCore, `Source/WebCore/html/FileInputType.cpp`,
/// `handleDOMActivateEvent`). Tauri's `WebviewWindow::eval` reaches that
/// method through wry (wry 0.57.0, `src/wkwebview/mod.rs`,
/// `evaluateJavaScript_completionHandler`). The text is one line of plain
/// script, which `tests/native.mjs` reads from this file and runs in the
/// page; the test below holds it to the page's ids.
const PRESS: &str = r"(() => { const open = (id) => { const el = document.getElementById(id); return Boolean(el) && !el.hidden; }; if (open('intro') || open('pw')) return false; const button = document.getElementById('BUTTON'); if (!button || button.hidden) return false; button.click(); return true; })()";

/// The script that presses the page's button with that id.
pub fn press_script(button: &str) -> String {
    PRESS.replace("BUTTON", button)
}

/// Presses the page's button for a menu item, if the item has one.
pub fn press<R: Runtime>(app: &AppHandle<R>, item: &str) {
    let Some(button) = button_for(item) else {
        return;
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(press_script(button));
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            // Labels from the product name, not the process name, so a test
            // build run outside the bundle reads the same.
            &PredefinedMenuItem::about(app, Some(&format!("About {name}")), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&format!("Hide {name}")))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    // Open... and Save... press the page's own buttons (main.rs, press); Close
    // Window sends performClose:, which reaches the window's close request.
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, OPEN, "Open...", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, SAVE, "Save...", true, Some("CmdOrCtrl+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some("Enter Full Screen"),
        )?],
    )?;
    // With these two ids Tauri makes them the app's Window and Help menus, so
    // macOS lists the window in one and adds its search field to the other.
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;
    // The help item opens the page's intro, the ? button's action.
    let help = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[&MenuItem::with_id(
            app,
            HELP,
            format!("{name} Help"),
            true,
            None::<&str>,
        )?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The repository's page, whose ids the script names.
    const PAGE: &str = include_str!("../../../index.html");

    #[test]
    fn each_item_presses_a_button_the_page_has_and_nothing_else() {
        for (item, button) in [(OPEN, "btn-open"), (SAVE, "btn-save"), (HELP, "btn-help")] {
            assert_eq!(button_for(item), Some(button));
            assert!(
                PAGE.contains(&format!("id=\"{button}\"")),
                "the page has {button}"
            );
        }
        assert_eq!(button_for(QUIT), None, "Quit presses no button");
        assert_eq!(button_for("anything else"), None);
    }

    #[test]
    fn the_script_clicks_the_button_only_while_no_dialog_is_open() {
        let script = press_script("btn-save");
        for dialog in ["intro", "pw"] {
            assert!(
                PAGE.contains(&format!("id=\"{dialog}\"")),
                "the page has the dialog {dialog}"
            );
        }
        assert!(
            script.contains("if (open('intro') || open('pw')) return false;"),
            "both dialogs stop the press: {script}"
        );
        assert!(
            script.contains("return Boolean(el) && !el.hidden;"),
            "a dialog counts as open when it is not hidden"
        );
        assert!(
            script.contains("document.getElementById('btn-save')"),
            "the button is the item's: {script}"
        );
        assert!(
            script.contains("if (!button || button.hidden) return false;"),
            "a hidden button is not pressed (QA-G-26, Me3): {script}"
        );
        assert!(
            script.ends_with("button.click(); return true; })()"),
            "the press is a click: {script}"
        );
        assert!(!script.contains("BUTTON"), "the placeholder is replaced");
        assert!(
            !script.contains('\n'),
            "one line, so it runs as one expression"
        );
    }
}
