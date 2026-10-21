//! Test builds only (cargo feature `e2e`). The release app is built without
//! this feature, so none of this code is in it.
//!
//! It lets the end-to-end tests read the page and take pictures of it while
//! they drive it, through files in `$PLAIN_SIGHT_E2E_DIR`, because macOS
//! keeps window contents away from other programs while the screen is locked
//! and the test runner has no Screen Recording permission. The runner writes
//! `request.json`, `{"id": 1, "eval": "<expression>"}` or
//! `{"id": 2, "snapshot": "name.png"}`; the app answers in `response-<id>.json`
//! with `{"ok": true, "value": ...}` or `{"ok": false, "error": "..."}`.
//!
//! The quit paths (quit.rs) and the title: `{"id": n, "close": true}` closes the
//! window as its red button does, `{"id": n, "quit": "menu"}` does what the Quit
//! item does, `{"id": n, "quit": "terminate"}` sends terminate: as the Dock's
//! Quit does, and `{"id": n, "windowTitle": true}` answers the window's title.
//! The first three answer before they act, since the app may be gone after.

use std::path::{Path, PathBuf};
use std::time::Duration;

use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWindow};
use objc2_foundation::{NSDictionary, NSError, NSString};
use objc2_web_kit::WKWebView;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::quit::macos::on_main_run_loop;

pub fn watch(app: AppHandle) {
    let Some(dir) = std::env::var_os("PLAIN_SIGHT_E2E_DIR").map(PathBuf::from) else {
        return;
    };
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(40));
        let request = dir.join("request.json");
        let Ok(text) = std::fs::read_to_string(&request) else {
            continue;
        };
        let _ = std::fs::remove_file(&request);
        let Ok(req) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let id = req["id"].as_u64().unwrap_or(0);
        let answer = dir.join(format!("response-{id}.json"));
        let Some(window) = app.get_webview_window("main") else {
            respond(&answer, json!({ "ok": false, "error": "no window" }));
            continue;
        };
        if let Some(expression) = req["eval"].as_str() {
            // The page's own world, so the page's DOM and globals are visible.
            let script = format!("JSON.stringify(({expression}) ?? null)");
            let _ = window
                .with_webview(move |webview| unsafe { eval(webview.inner(), &script, answer) });
        } else if let Some(name) = req["snapshot"].as_str() {
            // A bare PNG name only, so a request can never write outside the folder.
            if name.contains('/') || !name.ends_with(".png") {
                respond(&answer, json!({ "ok": false, "error": "bad name" }));
                continue;
            }
            let target = dir.join(name);
            let _ = window
                .with_webview(move |webview| unsafe { snapshot(webview.inner(), target, answer) });
        } else if req["windowTitle"].as_bool() == Some(true) {
            respond(&answer, json!({ "ok": true, "value": window.title().ok() }));
        } else if req["close"].as_bool() == Some(true) {
            respond(&answer, json!({ "ok": true }));
            // The red button's own path: performClose: asks windowShouldClose:,
            // which becomes the window's close request. From the main run loop,
            // outside tao's event handler, as AppKit itself would call it.
            on_main_run_loop(move || {
                if let Ok(ns_window) = window.ns_window() {
                    // SAFETY: Tauri's pointer to the window's NSWindow, on the main thread.
                    let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
                    ns_window.performClose(None);
                }
            });
        } else if let Some(how) = req["quit"].as_str() {
            match how {
                "menu" => {
                    respond(&answer, json!({ "ok": true }));
                    crate::quit::begin(&app);
                }
                "terminate" => {
                    respond(&answer, json!({ "ok": true }));
                    on_main_run_loop(|| {
                        if let Some(mtm) = MainThreadMarker::new() {
                            NSApplication::sharedApplication(mtm).terminate(None);
                        }
                    });
                }
                _ => respond(&answer, json!({ "ok": false, "error": "unknown quit" })),
            }
        }
    });
}

fn respond(path: &Path, value: Value) {
    // Write then rename, so the runner never reads half an answer.
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, value.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// # Safety
/// `webview` must be the WKWebView pointer Tauri hands to `with_webview`, on the main thread.
unsafe fn eval(webview: *mut std::ffi::c_void, script: &str, answer: PathBuf) {
    let webview: &WKWebView = &*webview.cast();
    let done = block2::RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
        if let Some(error) = unsafe { error.as_ref() } {
            respond(
                &answer,
                json!({ "ok": false, "error": error.localizedDescription().to_string() }),
            );
            return;
        }
        let text = unsafe { result.as_ref() }
            .and_then(|r| r.downcast_ref::<NSString>())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "null".to_owned());
        let value = serde_json::from_str::<Value>(&text).unwrap_or(Value::Null);
        respond(&answer, json!({ "ok": true, "value": value }));
    });
    webview.evaluateJavaScript_completionHandler(&NSString::from_str(script), Some(&done));
}

/// # Safety
/// `webview` must be the WKWebView pointer Tauri hands to `with_webview`, on the main thread.
unsafe fn snapshot(webview: *mut std::ffi::c_void, target: PathBuf, answer: PathBuf) {
    let webview: &WKWebView = &*webview.cast();
    let done = block2::RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
        let png = unsafe { image.as_ref() }
            .and_then(|image| image.TIFFRepresentation())
            .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
            .and_then(|bitmap| {
                let options = NSDictionary::<NSString, AnyObject>::new();
                unsafe {
                    bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &options)
                }
            });
        let ok = png.is_some_and(|png| std::fs::write(&target, png.to_vec()).is_ok());
        respond(&answer, json!({ "ok": ok }));
    });
    webview.takeSnapshotWithConfiguration_completionHandler(None, &done);
}
