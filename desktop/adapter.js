// The desktop app's side of the page. The page calls window.PlainSightNative
// (index.html, search for "native") and each call here becomes one of the
// app's own commands (src-tauri/src/folder.rs). The app keeps the folder's
// path; the page only ever gets the folder's name (D-07). The app also runs
// window.__plainSightQuit before it closes or quits (src-tauri/src/quit.rs).
//
// The app injects this before the page runs, in the main frame only, after
// Tauri's own scripts, which provide __TAURI_INTERNALS__.invoke. Both objects
// are fixed: the properties can be neither replaced nor deleted, so nothing
// that runs later in the page can swap them for others.
(() => {
  'use strict';
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const fixed = (name, value) => Object.defineProperty(window, name, { value, writable: false, configurable: false, enumerable: false });
  let quitCallback = null;   // the page's quit hook, run by __plainSightQuit below

  fixed('PlainSightNative', Object.freeze({
    // { name } of the chosen folder, or null when the picker is cancelled.
    pickFolder: () => invoke('pick_folder'),
    // { name } of the folder remembered from an earlier run, or null.
    savedFolder: () => invoke('saved_folder'),
    forgetFolder: () => invoke('forget_folder').then(() => undefined),
    // The file name used, such as "2026-10-20 14-55-03 (2).txt".
    writeTextFile: (base, text) => invoke('write_text_file', { base, text }),
    // Save without a folder: the app writes the file into Downloads and answers
    // with the name it used, or fails, so the page's toast tells the truth.
    saveDownload: (name, text) => invoke('save_download', { name, text }),
    onQuit: (callback) => { if (typeof callback === 'function') quitCallback = callback; }
  }));

  // Closing the window or quitting the app runs this first. The page's quit
  // callback (Esc's wipe and the vault's last write) gets up to 2.5 seconds,
  // then the app is told it may end. A failing callback must not keep the app
  // open, and quit_ready is refused unless the app is really quitting.
  fixed('__plainSightQuit', async () => {
    try {
      await Promise.race([
        new Promise((resolve) => resolve(quitCallback ? quitCallback() : undefined)),
        new Promise((resolve) => setTimeout(resolve, 2500))
      ]);
    } catch (err) { /* the app ends anyway */ }
    return invoke('quit_ready').catch(() => {});
  });

  // A right click on the page shows no menu, so it offers no Reload, Back,
  // Inspect or web search of the text. Text fields keep theirs, with Cut, Copy
  // and Paste; checkboxes and radio buttons are not text fields.
  const textField = (el) => el instanceof Element &&
    el.matches('textarea, input:not([type]), input[type="text"], input[type="password"], input[type="search"]');
  window.addEventListener('contextmenu', (e) => { if (!textField(e.target)) e.preventDefault(); }, true);
})();
