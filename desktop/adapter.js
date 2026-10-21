// The desktop app's side of the page's folder feature. The page calls
// window.PlainSightNative (index.html, search for "native") and each call here
// becomes one of the app's own commands (src-tauri/src/folder.rs). The app
// keeps the folder's path; the page only ever gets the folder's name (D-07).
//
// The app injects this before the page runs, in the main frame only, after
// Tauri's own scripts, which provide __TAURI_INTERNALS__.invoke. The object is
// frozen and the property can be neither replaced nor deleted, so nothing that
// runs later in the page can swap the adapter for another one.
(() => {
  'use strict';
  const invoke = window.__TAURI_INTERNALS__.invoke;
  let quitCallback = null;   // the page's quit hook; the app calls it from Wave C on

  const api = Object.freeze({
    // { name } of the chosen folder, or null when the picker is cancelled.
    pickFolder: () => invoke('pick_folder'),
    // { name } of the folder remembered from an earlier run, or null.
    savedFolder: () => invoke('saved_folder'),
    forgetFolder: () => invoke('forget_folder').then(() => undefined),
    // The file name used, such as "2026-10-20 14-55-03 (2).txt".
    writeTextFile: (base, text) => invoke('write_text_file', { base, text }),
    onQuit: (callback) => { if (typeof callback === 'function') quitCallback = callback; }
  });

  Object.defineProperty(window, 'PlainSightNative', { value: api, writable: false, configurable: false, enumerable: false });
})();
