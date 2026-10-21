# Desktop app changelog

One entry per wave of the Mac app on the `desktop` branch. The web page's own changelog is `../CHANGELOG.md`.

## Wave A, 20 and 21 October 2026: the page as a Mac app (5035a3d to 7405a87)

A Tauri 2.12.4 shell under `desktop/` opens the unchanged `index.html` and its three covers in a Mac window. The page is served from inside the app under its own content security policy, which the shell also sends as a header, so a blocked request is refused by both copies. An allowlist script copies the page and its covers into the app before every build. The window shows nothing but the app's own page: navigation away and new windows are refused. The release build is optimised for size and the app is about 3 MB.

Two kinds of end-to-end tests run the real app on this Mac: `e2e.mjs` drives a test build from inside the page (it works while the screen is locked) and `app.mjs` drives the release app with real key presses through macOS. A run waits until nobody is using the Mac, stops at the first touch, and puts the app's data, the clipboard and the Downloads folder back as they were. `npm test` also runs the jsdom tests of the app's branch of the engine and static checks of the shell's configuration. A dropped release profile (the app had grown to 9.9 MB) was found by the size check and restored in 4d539d9; a config check guards it.

## Wave B, 21 October 2026: saving into a folder (336c8e6, ed952df, 9a16c73)

One guarded branch in `index.html` lets the page use the app when the app is there: "Choose a folder on this computer" opens the system folder picker, Save writes `YYYY-MM-DD HH-MM-SS.txt` into the chosen folder with the web page's names and counter, and the intro's wording speaks of an app instead of a browser. In a browser the branch does nothing. The app keeps the chosen folder's path in its own data folder and gives the page only the folder's name; it writes each file with create-new semantics, so no file is ever overwritten, and waits for the disk before it reports success. The folder picker is the system panel through `rfd`; Tauri's dialog plugin was not used because it adds a script to every page.

## Wave C, 21 October 2026: app behaviour and packaging (ef3784c to aa9dd3c)

Closing the window and quitting work like Esc first: the window's close button, Cmd+W, the app's Quit item (Cmd+Q) and a quit from the Dock all run the page's own Esc, which saves an open vault and locks it, before the app ends through macOS's normal termination. The window's title follows the cover on screen, the menu bar is the app's own with nothing in it but standard items, a right click on the page shows no menu (text fields keep theirs), and the app asks WebKit to keep Apple's Writing Tools away from the page.

Fixes from the first QA round: Save without a folder now writes into Downloads through the app, which reports the name it used or the failure, so the page says "Could not save" when nothing was written instead of "Saved" (DM-202); the bundle is now sealed with an ad-hoc signature and the hardened runtime (DM-201); the copy step bundles exactly the covers `index.html` names; new checks read the built app itself (its files, signature and the four page files embedded in its binary) and guard the shell's configuration; the test harness puts everything back when it is interrupted; the app declares macOS 11 as its minimum. A network watch around a full session of the end-to-end tests saw no socket and no network flow from the app or its web view's networking process. `SIGNING.md` lists the steps for a Developer ID signature and notarization.
