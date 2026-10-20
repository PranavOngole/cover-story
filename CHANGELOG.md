# Changelog

One entry per wave. Dates are the day the wave was committed.

## Wave 0, 2026-10-19 (cdb23ab)

Repo and test harness. Version 1 of the page built from the spec: the novel cover, the typing engine with simulated typos, peek on a 900 ms hold of Ctrl or Cmd, copy while peeking, Esc to clear, the 10-minute hidden-tab wipe, and password-protected save and open (AES-256-GCM, PBKDF2 with 310,000 iterations). MIT license, `.gitignore`, `package.json` with jsdom as the only development dependency, and `tests/smoke.mjs` with 18 tests that drive the real page in jsdom. Every area of the suite was shown to go red under a deliberate break of the engine. Public repository created on GitHub.

## Wave 1, 2026-10-19 (fd9c4fe)

Engine refactor. The story moved out of `index.html` into `covers/book.js` as an ES module, loaded by a small module script with a dynamic `import()` based on the remembered selection, with a visible notice if the import fails. The intro gained the version picker (only the novel enabled at this point) and the choice persists in `localStorage`. The test harness injects covers the way the module loader does, because jsdom does not run module scripts. Five tests added (23 total). First deployment to Vercel as static files; `.vercelignore` keeps the deployment to `index.html` and `covers/`.

## Wave 2, 2026-10-19 (abef9f7)

Version 2, the work document. `covers/work.js` with 1,280 words of fictional internal project notes. The engine renders a leading `- ` as a list item, with consecutive bullets sharing one list. The work look: sans-serif type, a narrower measure, a static "Last edited just now", and a toolbar of icon placeholders drawn in CSS that do nothing. Four tests added (27 total).

## Wave 3, 2026-10-19 (517600e)

Version 3, the research paper. `covers/paper.js` with a 1,626-word fictional paper and an invented reference list. The manuscript look: academic serif on a white sheet, a title block with placeholder author and affiliation taken from the cover file, a static "Page 1 of 1", and reference entries typed as text but styled with a hanging indent. Citations such as [1] pass through as plain text. Three tests added (30 total).

## Wave 4, 2026-10-19 (6b23054)

Deploy and README. The site is deployed with the Vercel CLI as static files (framework none) and verified on the deployed URL in headless Chromium and WebKit: the intro appears, all three covers work, there are no console errors or page errors, the only requests are the page's own files, and nothing overflows at 390px. README.md added with the live URL, a GIF placeholder and recording instruction, one screenshot per version in docs/, how it works, the save file format, the threat model, the corporate IT note, known limitations (no mobile support), local run and test instructions and the fictional-content disclosure. The page and package versions were aligned at 1.0.0 (2805a7f).

## Wave 5, 2026-10-19 (this commit)

Final handoff. This changelog added. No other changes.

## Post-gate fixes, 2026-10-20 (c587c3e)

An independent Delivery Manager gate on 16da45d found no P0 or P1 issues, one P2 and ten P3. Fixed here: the README's broken demo image replaced by a plain placeholder (DM-001); the encryption functions removed from the console object so nothing on it touches the hidden buffer in any form (DM-002); pasted or composed text and Alt, Option and AltGr characters listed as known limitations (DM-003, DM-004); the Shift+Tab sentence corrected for Safari (DM-005); a guard test that localStorage never holds the hidden text (DM-006); a dialog now cancels a pending or active peek (DM-007); a failed cover switch no longer leaves its id in storage (DM-008); Open refuses files whose descriptive fields do not match (DM-009); two story characters renamed (DM-011). Left as is: DM-010, a harmless rendering quirk of custom cover text whose lines are only "- ". Suite now 33 tests. A follow-up (1610230) extended the peek test to an active peek when Save is clicked and removed a duplicate check inside beginPeek that no path could reach and that masked the real guard under mutation testing.

## 1.1.0, 2026-10-20: Plain Sight (this commit)

The project is renamed from Cover Story to Plain Sight: intro title, README, package name, storage keys (`plainSight.*`), the console object (`window.PlainSight`) and the saved file extension, now `.sight` with the format label `plain-sight`. Files saved under the old name still open. Peek is now a chord, Ctrl+Shift+G (Cmd+Shift+G), that toggles the real text on and off; typing, a window blur, a hidden tab or any dialog ends it, and the 900 ms hold is gone. New, off by default: a device vault. Tick "Keep my text on this device" on the intro and choose a phrase of 12 characters or more; the page then keeps the hidden text in localStorage as AES-256-GCM ciphertext under a key derived from the phrase (PBKDF2, 310,000 iterations, fresh salt), saved 1.5 seconds after the last keystroke, when the tab is hidden and on Esc. Esc, the 10-minute wipe and closing the tab lock the vault and keep the copy. To come back, type the phrase on the blank page, then hold Ctrl (Cmd), press E, then Enter; a wrong phrase does nothing. The only sign of an open vault is the header text drawn in ink instead of grey. Unticking the box deletes the copy. Suite now 36 tests; verified in headless WebKit with real key events.

## 1.1.1, 2026-10-20: gate fixes (this commit)

An independent Delivery Manager gate on 643bdf3 found one P1, two P2 and five P3 issues, all fixed here. Esc now saves an open vault before locking it (DM-101: the save ran after the lock and was skipped, losing the last 1.5 seconds of typing). A phrase entered while a saved copy is locked opens that copy, with text typed before added after it, and a phrase that does not open it is refused, so a locked copy is never overwritten (DM-102). Esc on the intro applies the vault choices exactly like Start (DM-103). An unreadable vault record can be deleted by unticking the box (DM-104). Esc cancels an unlock still in flight, and keys typed while the key derives are kept after the saved text (DM-105). The page also saves on the way out (DM-106). The README now says a simulated typo costs two keystrokes (DM-107) and the test names carry the new project name (DM-108). Suite now 40 tests.

## 1.1.2, 2026-10-20: storage key migration (this commit)

Visitors who used the page before the rename keep their intro flag, cover choice and custom cover text: the old coverStory.* keys are moved to plainSight.* once and removed. The README notes that two tabs share one vault copy with the last save winning.
