// End-to-end tests of the desktop app that run inside the real app: the real
// shell, the real WebKit view, the real files on disk and real relaunches.
// They need the test build (`npm run build:e2e`, cargo feature e2e), which
// lets a test read the page, run a line of script in it and take a picture of
// it. Key presses are dispatched inside the page, so these tests also run
// while the screen is locked; what needs real keys (the keyboard path through
// macOS, the clipboard, the open panel, the menus) is in app.mjs.
//
// Run from desktop/: npm run test:e2e   (exit code 0 only when every test passes)

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DESKTOP, DOWNLOADS, EVIDENCE, HOME, ID, alive, decryptRecord, drive, isCoverPrefix, newDownloads, note, novelText,
  run, sleep, spawnApp, stopApp, until
} from './harness.mjs';

const EXE = process.env.PLAIN_SIGHT_E2E_APP || path.join(DESKTOP, 'src-tauri/target/e2e/release/plain-sight');
const PROBE = path.join(EVIDENCE, 'probe');
const PICTURES = path.join(EVIDENCE, 'pictures');
mkdirSync(PROBE, { recursive: true });
mkdirSync(PICTURES, { recursive: true });

let app = null;
let requestId = 0;

// The app's visible windows. The window server also lists an off-screen
// helper window of AppKit's for every app; it is never shown.
const documentWindows = () => drive('cgwindows', app.pid).windows.filter((w) => w.layer === 0 && w.onscreen);

// One request at a time through the probe folder (see src-tauri/src/e2e.rs).
async function ask(request, ms = 8000) {
  const id = ++requestId;
  const tmp = path.join(PROBE, 'request.tmp');
  writeFileSync(tmp, JSON.stringify({ id, ...request }));
  renameSync(tmp, path.join(PROBE, 'request.json'));
  const answer = path.join(PROBE, `response-${id}.json`);
  await until(() => existsSync(answer), 'the app to answer request ' + id, ms);
  const reply = JSON.parse(readFileSync(answer, 'utf8'));
  rmSync(answer);
  note('probe ' + JSON.stringify(request).slice(0, 140) + ' -> ' + JSON.stringify(reply).slice(0, 200));
  if (!reply.ok) throw new Error('probe: ' + reply.error);
  return reply.value;
}
const js = (expression) => ask({ eval: expression });
async function picture(name) {
  const value = await ask({ snapshot: name }, 10000).catch((err) => { note('picture failed: ' + err.message); return null; });
  if (value === null) return null;
  const from = path.join(PROBE, name);
  if (existsSync(from)) renameSync(from, path.join(PICTURES, name));
  return path.join(PICTURES, name);
}

async function launch(env = {}) {
  const child = spawnApp(EXE, { PLAIN_SIGHT_E2E_DIR: PROBE, ...env });
  app = { child, pid: child.pid };
  await until(() => documentWindows().length === 1, 'the app window', 20000);
  await until(async () => (await js('window.PlainSight && window.PlainSight.coverId()')) !== null, 'the cover to load', 15000);
  return app;
}

// The page, through the probe. Key presses are dispatched where the page
// listens for them, the focused element or the body, as a key press would be.
const page = {
  text: (id) => js(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return el && el.getClientRects().length ? el.textContent : null; })()`),
  // The cover's blocks, one per line, as the reference model renders them.
  coverBlocks: () => js(`Array.from(document.querySelectorAll('#cover > p, #cover > h2, #cover > ul > li')).map((el) => el.textContent).join('\\n')`),
  shown: (id) => js(`(() => { const el = document.getElementById(${JSON.stringify(id)}); return Boolean(el && el.getClientRects().length); })()`),
  press: (key, mods = {}) => js(`(() => { const t = document.activeElement || document.body; const e = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, metaKey: ${!!mods.meta}, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, altKey: ${!!mods.alt}, bubbles: true, cancelable: true }); t.dispatchEvent(e); return e.defaultPrevented; })()`),
  type: (text) => js(`(() => { for (const ch of ${JSON.stringify(text)}) { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: ch === '\\n' ? 'Enter' : ch, bubbles: true, cancelable: true })); } return true; })()`),
  click: (id) => js(`(() => { document.getElementById(${JSON.stringify(id)}).click(); return true; })()`),
  choose: (name, value) => js(`(() => { const r = document.querySelector('input[name=${JSON.stringify(name)}][value=${JSON.stringify(value)}]'); r.click(); return r.checked; })()`),
  async peekText() {
    await page.press('G', { meta: true, shift: true });
    const text = await page.text('real');
    await page.press('G', { meta: true, shift: true });
    return text;
  },
  async start() {
    await page.click('btn-start');
    await until(async () => !(await page.shown('intro')), 'the intro to close');
  },
  async openIntro() {
    await page.click('btn-help');
    await until(() => page.shown('intro'), 'the intro to open');
  },
  async password(value) {
    await until(() => page.shown('pw'), 'the password dialog');
    await js(`(() => { document.getElementById('pw-input').value = ${JSON.stringify(value)}; document.getElementById('pw-ok').click(); return true; })()`);
  },
  toast: () => js(`document.getElementById('toast').textContent`),
  waitToast: (fragment, ms = 15000) => until(async () => { const t = await page.toast(); return t.includes(fragment) && t; }, 'a toast with "' + fragment + '"', ms)
};

const PASSWORD = 'file password for the test run';
const PHRASE = 'vault phrase for the test run';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('first launch: one document window, the page from the app itself in a secure context, the intro on top', async () => {
  await launch();
  const windows = documentWindows();
  assert.equal(windows.length, 1, 'one window');
  assert.deepEqual([windows[0].width, windows[0].height], [1000, 760], 'the window opens at 1000 x 760');
  const facts = await js(`({ href: location.href, secure: window.isSecureContext, subtle: typeof crypto.subtle, title: document.title, intro: document.getElementById('intro').hidden === false, header: document.getElementById('header-left').textContent, notice: document.getElementById('load-notice').hidden })`);
  assert.deepEqual(facts, { href: 'tauri://localhost', secure: true, subtle: 'object', title: 'Untitled draft', intro: true, header: 'Untitled draft', notice: true });
  await picture('a01-intro.png');
});

test('typing shows the novel, never the real text; the word count counts the cover', async () => {
  await page.start();
  await page.type('meet me at the north gate at nine');
  const cover = await page.coverBlocks();
  assert.ok(cover.length > 20, 'the cover shows text');
  assert.ok(isCoverPrefix(cover, await novelText()), 'the cover is the novel: ' + JSON.stringify(cover));
  assert.equal(await js(`document.body.innerText.includes('north gate')`), false, 'the real text is nowhere on screen');
  const words = (cover.match(/\S+/g) || []).length;
  assert.equal(await page.text('word-count'), words + (words === 1 ? ' word' : ' words'));
  await picture('a02-novel.png');
});

test('Cmd+Shift+G shows exactly the real text and hides it again; typing ends a peek', async () => {
  assert.equal(await page.press('G', { meta: true, shift: true }), true, 'the chord is taken by the page');
  assert.equal(await page.text('real'), 'meet me at the north gate at nine');
  assert.equal(await page.shown('cover'), false, 'the cover is hidden while peeking');
  await picture('a03-peek.png');
  await page.press('G', { meta: true, shift: true });
  assert.equal(await page.shown('real'), false);
  await page.press('G', { meta: true, shift: true });
  await page.type('!');
  assert.equal(await page.shown('real'), false, 'typing ended the peek');
  assert.equal(await page.peekText(), 'meet me at the north gate at nine!');
});

test('Esc erases the real text and the screen', async () => {
  await page.press('Escape');
  assert.equal(await page.text('cover'), '');
  assert.equal(await page.peekText(), '');
});

test('the work document and the research paper covers load from the intro, with their own looks', async () => {
  await page.openIntro();
  assert.equal(await page.choose('mode', 'work'), true);
  await page.start();
  await until(async () => (await page.text('header-left')) === 'Q3 planning notes', 'the work header');
  assert.equal(await page.text('last-edited'), 'Last edited just now');
  assert.equal(await page.shown('toolbar'), true, 'the decorative toolbar shows');
  assert.equal(await js('document.title'), 'Q3 planning notes');
  await page.type('ordinary words for the work cover');
  await picture('a04-work.png');
  await page.press('Escape');
  await page.openIntro();
  await page.choose('mode', 'paper');
  await page.start();
  await until(async () => (await page.text('header-left')) === 'Manuscript draft', 'the paper header');
  assert.equal(await page.text('page-count'), 'Page 1 of 1');
  assert.match(await page.text('paper-title'), /^Variability in Regional Rainfall/);
  await page.type('ordinary words for the paper cover');
  await picture('a05-paper.png');
  await page.press('Escape');
  await page.openIntro();
  await page.choose('mode', 'book');
  await page.start();
  await until(async () => (await page.text('header-left')) === 'Untitled draft', 'the novel header');
});

test('Save downloads an encrypted .sight file into Downloads under the page\'s name; it decrypts to the text', async () => {
  await page.type('saved through the app');
  await page.click('btn-save');
  await page.password(PASSWORD);
  await page.waitToast('Saved');
  const files = await until(() => { const f = newDownloads().filter((n) => n.endsWith('.sight')); return f.length ? f : null; }, 'a .sight file in Downloads', 10000);
  assert.equal(files.length, 1);
  assert.match(files[0], /^untitled-draft-\d{8}-\d{4}\.sight$/);
  const record = JSON.parse(readFileSync(path.join(DOWNLOADS, files[0]), 'utf8'));
  assert.equal(record.format, 'plain-sight');
  assert.equal(record.iterations, 310000);
  assert.equal(Buffer.from(record.salt, 'base64').length, 16);
  assert.equal(Buffer.from(record.iv, 'base64').length, 12);
  assert.equal(await decryptRecord(record, PASSWORD), 'saved through the app');
});

test('the plain .txt mode downloads the exact text, named by the moment', async () => {
  await page.openIntro();
  await page.choose('save-mode', 'txt');
  await page.start();
  await page.click('btn-save');
  const name = (await page.waitToast('Saved 2')).replace(/^Saved /, '');
  assert.match(name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
  await until(() => newDownloads().includes(name), 'the .txt file', 10000);
  assert.equal(readFileSync(path.join(DOWNLOADS, name), 'utf8'), 'saved through the app');
});

test('a download name that is taken gets " (2)" and the file already there is left untouched', async () => {
  // The page names a .txt by the second of the click, so the names of the
  // next few seconds are taken in advance by files the app must not touch.
  const stamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()); };
  const taken = [];
  for (let s = 0; s < 4; s++) {
    const name = stamp(new Date(Date.now() + s * 1000)) + '.txt';
    writeFileSync(path.join(DOWNLOADS, name), 'placed here by the test, must stay as it is');
    taken.push(name);
  }
  await page.click('btn-save');
  const name = (await page.waitToast('Saved 2')).replace(/^Saved /, '');
  assert.ok(taken.includes(name), 'the page asked for a name that was taken: ' + name);
  const numbered = name.replace(/\.txt$/, ' (2).txt');
  await until(() => newDownloads().includes(numbered), 'the numbered file ' + numbered, 10000);
  assert.equal(readFileSync(path.join(DOWNLOADS, numbered), 'utf8'), 'saved through the app');
  for (const n of taken) assert.equal(readFileSync(path.join(DOWNLOADS, n), 'utf8'), 'placed here by the test, must stay as it is', n + ' was not overwritten');
  await page.openIntro();
  await page.choose('save-mode', 'sight');
  await page.start();
});

test('the shell shows nothing but the app: navigation away and new windows are refused', async () => {
  await js(`(() => { location.href = 'https://example.com/'; return true; })()`);
  await sleep(1500);
  assert.equal(await js('location.href'), 'tauri://localhost', 'still on the app page');
  await js(`(() => { window.open('https://example.com/'); return true; })()`);
  await sleep(1500);
  assert.equal(documentWindows().length, 1, 'still one window');
});

test('the content security policy is enforced twice: by the shell\'s header and by the page', async () => {
  await js(`(() => { window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => window.__violations.push({ directive: e.effectiveDirective, policy: e.originalPolicy, uri: e.blockedURI })); fetch('https://example.com/').then(() => { window.__fetched = 'yes'; }, () => { window.__fetched = 'blocked'; }); return true; })()`);
  await sleep(1500);
  assert.equal(await js('window.__fetched'), 'blocked');
  const violations = await js('window.__violations');
  const policies = violations.map((v) => v.policy.split(';').map((d) => d.trim()).sort().join('; '));
  note('violations: ' + JSON.stringify(violations));
  assert.equal(violations.length, 2, 'one violation from each of the two policies');
  assert.equal(policies[0], policies[1], 'the shell\'s policy holds the same directives as the page\'s');
  assert.ok(violations.every((v) => v.directive === 'connect-src'));
});

test('the device vault keeps its copy across a quit and a relaunch, and the phrase plus Cmd+E then Cmd+Return reopens it', async () => {
  await page.press('Escape');
  await page.openIntro();
  await js(`(() => { const box = document.getElementById('vault-on'); box.click(); document.getElementById('vault-phrase').value = ${JSON.stringify(PHRASE)}; return box.checked; })()`);
  await page.start();
  await until(() => js(`document.body.classList.contains('vault-open')`), 'the vault to open', 10000);
  await page.type('kept in the vault');
  await sleep(4000);   // the autosave settles 1.5 s after the last key (timers run slower in a hidden page)
  const store = path.join(HOME, 'Library/WebKit', path.basename(EXE) === 'plain-sight' ? 'plain-sight' : ID);
  note('quitting with the vault open; WebKit data folder ' + store);
  await stopApp(app);   // SIGTERM: the window close and Cmd+Q paths are checked in app.mjs and in Wave C
  await launch();
  assert.equal(await page.shown('intro'), false, 'no intro on a return');
  await page.type(PHRASE);
  assert.equal(await page.press('e', { meta: true }), true, 'Cmd+E is taken while a vault exists');
  assert.equal(await page.press('Enter', { meta: true }), true, 'Cmd+Return is taken');
  await until(() => js(`document.body.classList.contains('vault-open')`), 'the vault to reopen', 10000);
  assert.equal(await page.peekText(), 'kept in the vault');
  await picture('a06-vault-open.png');
});

test('a wrong phrase does nothing', async () => {
  await page.press('Escape');
  await page.type('this is not the phrase at all');
  await page.press('e', { meta: true });
  await page.press('Enter', { meta: true });
  await sleep(2500);
  assert.equal(await js(`document.body.classList.contains('vault-open')`), false);
  assert.equal(await page.peekText(), 'this is not the phrase at all');
});

// ---------------------------------------------------------------------------
// Wave B: the folder, through the app's adapter. The test build's picker
// returns PLAIN_SIGHT_E2E_PICK instead of showing the panel (the real panel is
// tested with real keys in app.mjs).
// ---------------------------------------------------------------------------
const FOLDER = path.join(EVIDENCE, 'folders', 'Notes for the test');
const folderFiles = () => (existsSync(FOLDER) ? readdirSync(FOLDER).sort() : []);
const stamp = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds()); };

test('in the app the intro speaks of an app, not a browser, and offers the system folder picker', async () => {
  mkdirSync(FOLDER, { recursive: true });
  await stopApp(app);
  await launch({ PLAIN_SIGHT_E2E_PICK: FOLDER });
  await page.press('Escape');
  await page.openIntro();
  const intro = await js(`document.getElementById('intro').textContent`);
  assert.equal(/browser/i.test(intro), false, 'no browser in the intro');
  assert.equal(/\btab\b/i.test(intro), false, 'no tab in the intro');
  assert.match(intro, /Nothing you type leaves this app/);
  assert.match(intro, /Save my text on this computer, encrypted/);
  assert.equal(await page.shown('btn-folder'), true, 'the folder button shows');
  assert.equal(await page.shown('folder-help'), false, 'no browser help');
  assert.equal(await page.text('folder-status'), 'Save downloads an encrypted .sight file.');
  await picture('b01-intro-app-wording.png');
});

test('choosing a folder: the toast and the status name the folder, never its path', async () => {
  await page.click('btn-folder');
  await page.waitToast('Save now writes into Notes for the test');
  assert.equal(await page.text('folder-status'), 'Save writes a plain text file into the folder "Notes for the test".');
  assert.equal(await page.shown('btn-folder-forget'), true);
  assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(EVIDENCE)})`), false, 'the path is nowhere on the page');
  await picture('b02-folder-chosen.png');
  await page.start();
});

test('Save writes the exact text into the folder as a .txt named by the moment, with no password', async () => {
  await page.type('first words into the folder');
  const downloads = newDownloads().length;
  await page.click('btn-save');
  const toast = await page.waitToast(' in Notes for the test');
  const name = toast.replace(/^Saved /, '').replace(/ in Notes for the test$/, '');
  assert.match(name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
  assert.equal(readFileSync(path.join(FOLDER, name), 'utf8'), 'first words into the folder');
  assert.equal(await page.shown('pw'), false, 'no password asked');
  assert.equal(newDownloads().length, downloads, 'nothing downloaded');
});

test('two saves in the same second keep both files: the second gets " (2)"', async () => {
  let pair = null;
  for (let attempt = 0; attempt < 5 && !pair; attempt++) {
    const before = new Set(folderFiles());
    await js(`(() => { const b = document.getElementById('btn-save'); b.click(); b.click(); return true; })()`);
    await sleep(1200);
    const fresh = folderFiles().filter((n) => !before.has(n));
    const first = fresh.find((n) => !n.includes(' ('));
    if (first && fresh.includes(first.replace(/\.txt$/, ' (2).txt'))) pair = [first, first.replace(/\.txt$/, ' (2).txt')];
  }
  assert.ok(pair, 'a same-second pair was written');
  for (const n of pair) assert.equal(readFileSync(path.join(FOLDER, n), 'utf8'), 'first words into the folder');
});

test('a name already in the folder gets the next number and the file there is left untouched', async () => {
  const taken = [];
  for (let s = 0; s < 4; s++) {
    const name = stamp(new Date(Date.now() + s * 1000)) + '.txt';
    if (!existsSync(path.join(FOLDER, name))) { writeFileSync(path.join(FOLDER, name), 'placed by the test'); taken.push(name); }
  }
  await page.click('btn-save');
  const name = (await page.waitToast(' in Notes for the test')).replace(/^Saved /, '').replace(/ in Notes for the test$/, '');
  assert.match(name, / \(\d+\)\.txt$/, 'the saved name is numbered: ' + name);
  assert.equal(readFileSync(path.join(FOLDER, name), 'utf8'), 'first words into the folder');
  for (const n of taken) assert.equal(readFileSync(path.join(FOLDER, n), 'utf8'), 'placed by the test', n + ' untouched');
});

test('the folder is remembered across a relaunch, in the app\'s own data folder', async () => {
  const file = path.join(HOME, 'Library/Application Support', ID, 'folder.txt');
  assert.equal(readFileSync(file, 'utf8'), FOLDER, 'the path is kept by the app, in its data folder');
  await stopApp(app);
  await launch({ PLAIN_SIGHT_E2E_PICK: '/nonexistent/should-not-be-used' });
  await page.openIntro();
  assert.equal(await page.text('folder-status'), 'Save writes a plain text file into the folder "Notes for the test".');
  await page.start();
  await page.type('after the relaunch');
  const count = folderFiles().length;
  await page.click('btn-save');
  await page.waitToast(' in Notes for the test');
  assert.equal(folderFiles().length, count + 1);
});

test('the adapter cannot be replaced, gives no path, refuses any other file name, and the page can call nothing else', async () => {
  const facts = await js(`(() => {
    const n = window.PlainSightNative;
    let replaced = false; try { window.PlainSightNative = {}; replaced = window.PlainSightNative !== n; } catch (e) {}
    let deleted = false; try { deleted = delete window.PlainSightNative; } catch (e) {}
    return { frozen: Object.isFrozen(n), replaced, deleted, still: window.PlainSightNative === n, keys: Object.keys(n).sort() };
  })()`);
  assert.deepEqual(facts, { frozen: true, replaced: false, deleted: false, still: true, keys: ['forgetFolder', 'onQuit', 'pickFolder', 'savedFolder', 'writeTextFile'] });
  await js(`(() => { window.__r = {}; const I = window.__TAURI_INTERNALS__.invoke; const N = window.PlainSightNative;
    const note = (k, p) => p.then((v) => { window.__r[k] = 'ok ' + JSON.stringify(v); }, (e) => { window.__r[k] = 'refused ' + String(e); });
    note('saved', N.savedFolder());
    note('traversal', N.writeTextFile('../../outside', 'x'));
    note('nameWithSlash', N.writeTextFile('2026-10-21 00-00-00/x', 'x'));
    note('extension', N.writeTextFile('2026-10-21 00-00-00.txt', 'x'));
    note('dialog', I('plugin:dialog|open', {}));
    note('window', I('plugin:window|close', {}));
    note('event', I('plugin:event|listen', { event: 'x', handler: 0 }));
    note('fs', I('plugin:fs|read_text_file', { path: '/etc/hosts' }));
    note('unknown', I('quit_ready'));
    return true; })()`);
  await sleep(1500);
  const r = await js('window.__r');
  note('adapter probes: ' + JSON.stringify(r));
  assert.equal(r.saved, 'ok {"name":"Notes for the test"}', 'only the name');
  for (const k of ['traversal', 'nameWithSlash', 'extension']) assert.match(r[k], /^refused .*moment/, k);
  for (const k of ['dialog', 'window', 'event', 'fs', 'unknown']) assert.match(r[k], /^refused /, k + ' is refused');
  assert.equal(existsSync(path.join(FOLDER, '..', '..', 'outside.txt')), false);
});

test('a folder that has gone away: Save says it could not write, and the text stays', async () => {
  const moved = FOLDER + ' (moved away)';
  renameSync(FOLDER, moved);
  try {
    await page.click('btn-save');
    await page.waitToast('Could not write to the folder');
    assert.equal(await page.peekText(), 'after the relaunch');
  } finally {
    renameSync(moved, FOLDER);
  }
});

test('"Stop using the folder" forgets it, in the app\'s data too, and Save asks for a password again', async () => {
  await page.openIntro();
  await page.click('btn-folder-forget');
  await until(async () => (await page.text('folder-status')) === 'Save downloads an encrypted .sight file.', 'the status to change back');
  assert.equal(existsSync(path.join(HOME, 'Library/Application Support', ID, 'folder.txt')), false, 'the remembered path is deleted');
  await page.start();
  await page.click('btn-save');
  await until(() => page.shown('pw'), 'the password dialog');
  await page.press('Escape');
  await picture('b03-after-stop.png');
});

await run(tests, {
  name: 'e2e',
  after: async () => { if (app && alive(app.pid)) await stopApp(app); }
});
