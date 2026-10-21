# Changelog

One entry per wave. Dates are the day the wave was committed. The Mac app's changes are in `desktop/CHANGELOG.md`.

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

## Wave 5, 2026-10-19 (16da45d)

Final handoff. This changelog added. No other changes.

## Post-gate fixes, 2026-10-20 (c587c3e)

An independent Delivery Manager gate on 16da45d found no P0 or P1 issues, one P2 and ten P3. Fixed here: the README's broken demo image replaced by a plain placeholder (DM-001); the encryption functions removed from the console object so nothing on it touches the hidden buffer in any form (DM-002); pasted or composed text and Alt, Option and AltGr characters listed as known limitations (DM-003, DM-004); the Shift+Tab sentence corrected for Safari (DM-005); a guard test that localStorage never holds the hidden text (DM-006); a dialog now cancels a pending or active peek (DM-007); a failed cover switch no longer leaves its id in storage (DM-008); Open refuses files whose descriptive fields do not match (DM-009); two story characters renamed (DM-011). Left as is: DM-010, a harmless rendering quirk of custom cover text whose lines are only "- ". Suite now 33 tests. A follow-up (1610230) extended the peek test to an active peek when Save is clicked and removed a duplicate check inside beginPeek that no path could reach and that masked the real guard under mutation testing.

## 1.1.0, 2026-10-20: Plain Sight (643bdf3)

The project is renamed from Cover Story to Plain Sight: intro title, README, package name, storage keys (`plainSight.*`), the console object (`window.PlainSight`) and the saved file extension, now `.sight` with the format label `plain-sight`. Files saved under the old name still open. Peek is now a chord, Ctrl+Shift+G (Cmd+Shift+G), that toggles the real text on and off; typing, a window blur, a hidden tab or any dialog ends it, and the 900 ms hold is gone. New, off by default: a device vault. Tick "Keep my text on this device" on the intro and choose a phrase of 12 characters or more; the page then keeps the hidden text in localStorage as AES-256-GCM ciphertext under a key derived from the phrase (PBKDF2, 310,000 iterations, fresh salt), saved 1.5 seconds after the last keystroke, when the tab is hidden and on Esc. Esc, the 10-minute wipe and closing the tab lock the vault and keep the copy. To come back, type the phrase on the blank page, then hold Ctrl (Cmd), press E, then Enter; a wrong phrase does nothing. The only sign of an open vault is the header text drawn in ink instead of grey. Unticking the box deletes the copy. Suite now 36 tests; verified in headless WebKit with real key events.

## 1.1.1, 2026-10-20: gate fixes (58d0f62)

An independent Delivery Manager gate on 643bdf3 found one P1, two P2 and five P3 issues, all fixed here. Esc now saves an open vault before locking it (DM-101: the save ran after the lock and was skipped, losing the last 1.5 seconds of typing). A phrase entered while a saved copy is locked opens that copy, with text typed before added after it, and a phrase that does not open it is refused, so a locked copy is never overwritten (DM-102). Esc on the intro applies the vault choices exactly like Start (DM-103). An unreadable vault record can be deleted by unticking the box (DM-104). Esc cancels an unlock still in flight, and keys typed while the key derives are kept after the saved text (DM-105). The page also saves on the way out (DM-106). The README now says a simulated typo costs two keystrokes (DM-107) and the test names carry the new project name (DM-108). Suite now 40 tests.

## 1.1.2, 2026-10-20: storage key migration (77c5f3c)

Visitors who used the page before the rename keep their intro flag, cover choice and custom cover text: the old coverStory.* keys are moved to plainSight.* once and removed. The README notes that two tabs share one vault copy with the last save winning.

## 1.2.0, 2026-10-20: save into a folder (fbc6ae0)

On the intro screen, browsers with the File System Access API (Chrome, Edge) offer "Choose a folder on this computer". With a folder chosen, Save writes the real text as a plain text file named by the moment of the click, `YYYY-MM-DD HH-MM-SS.txt`, into that folder, with no password; "Stop using the folder" brings the encrypted download back. The folder handle is kept in IndexedDB. Other browsers keep the download. The README says plainly that these files are unencrypted on disk. Suite now 44 tests, the folder exercised with a simulated picker; a real Chrome check is still to come.

## 1.2.1, 2026-10-20: second gate fixes

The 1.1.2 gate (GO for testing, GO for go-live, four new findings) led to these fixes. Esc now sticks against any key derivation still in flight: a vault setup or phrase change started just before Esc is dropped and the old copy stays (DM-109); Save keeps the text that was on the page when it was confirmed, and Open is cancelled with its own toast (DM-110). A tab whose vault copy was deleted or re-keyed by another tab locks itself on the storage event, and every write checks that the copy on disk still carries its key's salt, so a stale tab never writes an old copy back (DM-111). Two leftover strings from the old name are gone and the changelog headings carry their commit ids (DM-108, DM-112). Suite now 48 tests.

## 1.2.2, 2026-10-20: third gate fixes

The 1.2.1 gate (GO for testing; go-live held until the folder feature is tried in a real Chrome) found three P2 and one P3 issue, fixed here. Vault writes now run through a queue, so a save still encrypting when Esc lands completes and the Esc save lands after it; a setup or phrase change still deriving its key is dropped by a separate counter, and only an untick drops writes in flight (DM-113). A folder Save writes the text that was on the page at the click even if Esc follows during the permission prompt (DM-114). Choosing or forgetting a folder in one tab is announced to the others, which reload or drop the handle (DM-115). A file name already taken gets a counter before the extension, so every Save is a new file as the README says (DM-116). Suite now 52 tests; a test switch slows encryption so the one-millisecond Esc windows are exercised deterministically.

## 1.3.0, 2026-10-20: every major browser

Save now has a plain `.txt` download mode, chosen on the intro screen and kept in localStorage, so Safari, Firefox and any browser without folder access can still save plain text files named by the moment, with no password; Safari and Firefox can be set to ask where each file goes. "Where Save writes" shows a note that fits the browser: Brave gets the setting to turn on (`brave://flags/#file-system-access-api`), Safari and Firefox their download tip, and folder-capable browsers no note. The README gains a browser support table. A new suite test proves vault writes land in the order asked for even when an older write is slower. Suite now 55 tests.

## 1.3.1, 2026-10-20: deployment allowlist

The Delivery Manager's gate on 1.2.2 found that every deployment since the first one had carried local tool folders from the working directory (a `.gstack` folder with a local terminal token and browser logs, and the gate agents' worktree copies), because `.vercelignore` listed what to exclude rather than what to include. `.vercelignore` is now an allowlist of `index.html` and `covers/` only; the deployment was rebuilt and the exposed paths return 404. Nothing typed by any user was involved: those files were local tool state, not page data. The README's deployment sentence is corrected.

## 1.3.2, 2026-10-20: fourth gate fixes

From the 1.2.2 gate: a folder file is now named by the moment of the click, not by the end of the permission prompt (DM-116); "Stop using the folder" is proven to reach other tabs (DM-115); and tests now guard three of the four fixes the suite had left unproven, including untick during a phrase change and a folder dropped while the permission prompt is up (DM-118; the fourth, an untick during key derivation, followed in 1.3.3). The Delivery Manager's definition now lists every file in each deployment and expects exactly the page and the three covers. Suite now 57 tests.

## 1.3.3, 2026-10-20: fifth gate fixes

From the 1.3.2 gate: "Stop using the folder" and the open intro now name the download choice in force, plain .txt or encrypted, and an intro left open in another tab redraws when the choice changes (DM-119); an untick now also drops a first-time vault setup still deriving its key, with a test, which closes the open part of DM-118 (DM-120); the Safari help and the README warn that Safari opens downloaded text files by itself unless "Open safe files after downloading" is off, which with the plain .txt choice would put the hidden text on screen; the README browser table now says which browsers were checked on this version, and the threat model names the plain .txt download (DM-121). The dates of the 1.3.1 and 1.3.2 entries were corrected to 20 October from the commit log. Suite now 59 tests; each of the four new guards was shown to go red under a deliberate break.

## 1.3.4, 2026-10-21: fifth gate follow-ups

Two gaps around unticks. The 1.3.3 untick fix meant that an intro opened and closed during the half second a first-time setup takes would drop the setup without a word; the intro now shows a pending setup as ticked with the status "Your phrase is being set up. Untick to cancel it.", closing it with an empty phrase field keeps the setup, and a deliberate untick says "Vault setup cancelled". From the 1.3.3 gate: an untick during an unlock still deriving its key deleted the copy and then opened the vault anyway with the deleted text back in the buffer (DM-122); an unlock now checks that the copy on the device is the one it started from, otherwise it does nothing, and the intro's phrase check says "The saved copy changed in another tab" in the same case. README: the Chrome row no longer claims the folder API matches the tested engines, and the allowlist date reads 20 October (DM-123). `.gitignore` now excludes `.claude/` and `.gstack/` so a careless `git add` cannot put tool files into the public repository. The browser-note tests now compare the whole text, not a fragment. Suite now 64 tests; each new guard was shown to go red under a deliberate break.

## 1.3.5, 2026-10-21: sixth gate follow-ups

From the 1.3.4 gate: a failed key derivation no longer leaves a setup shown as pending for the life of the page; the setup is dropped with the toast "The vault could not be set up" (DM-124). On an address without encryption (plain http other than localhost) the intro now says so and keeps the vault box off, and the README says to use localhost or https. After "The saved copy changed in another tab" only the vault controls redraw, so the cover and custom text picked on the intro are kept (DM-125). A phrase change still deriving is dropped when another tab deletes or re-keys the copy, so a tab that says it is locked stays locked (the note carried since 1.2.1). Three tests close gaps the gate found in the suite: a copy rewritten under the same salt during an unlock, a setup dropped by Esc not shown as pending, and the open-vault status during a phrase change. Suite now 71 tests.

## 1.3.6, 2026-10-21: seventh gate follow-ups

From the 1.3.5 gate: on an address without encryption, Start or Esc on the intro no longer deletes a saved copy that the disabled box could not show (DM-126); Save and Open say that the address gives the page no encryption instead of asking for a password or calling a good file damaged, and a return visit says so in a toast (DM-127). Every lock now drops a setup still deriving its key and any write still queued, which closes the last window in which another tab's delete could be undone by this tab's first save under a new phrase (the note carried as Q16b). Another tab clearing this site's storage locks this tab at once instead of at its next save, and an open intro follows the copy when another tab deletes, re-keys or creates it, while an autosave elsewhere leaves a phrase being typed alone. The vault status names an open vault first, so the moment between the key and its first save reads right. A completed setup no longer resets a pending flag: an open vault or any lock ends the pending state, so the reset the gate found unguarded was removed rather than kept untested. Suite now 77 tests.
