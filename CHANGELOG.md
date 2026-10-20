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

An independent Delivery Manager gate on 16da45d found no P0 or P1 issues, one P2 and ten P3. Fixed here: the README's broken demo image replaced by a plain placeholder (DM-001); the encryption functions removed from the console object so nothing on it touches the hidden buffer in any form (DM-002); pasted or composed text and Alt, Option and AltGr characters listed as known limitations (DM-003, DM-004); the Shift+Tab sentence corrected for Safari (DM-005); a guard test that localStorage never holds the hidden text (DM-006); a dialog now cancels a pending or active peek (DM-007); a failed cover switch no longer leaves its id in storage (DM-008); Open refuses files whose descriptive fields do not match (DM-009); two story characters renamed (DM-011). Left as is: DM-010, a harmless rendering quirk of custom cover text whose lines are only "- ". Suite now 33 tests.
