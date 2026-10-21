// Tests for the desktop app's branch of the engine. They run the real
// index.html in jsdom with a fake window.PlainSightNative, the adapter the
// desktop app injects before the page, and check that the page uses it for
// the folder, shows the app's wording and erases itself when the app quits.
// The adapter itself (the Rust side) is tested by the app tests.
//
// Run from the repository root: node desktop/tests/native.mjs   (exit code 0
// only when every test passes)

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// A promise the page leaves rejected is recorded, not fatal, so a test that
// expects a toast still reports its own assertion.
const unhandled = [];
process.on('unhandledRejection', (err) => { unhandled.push(String(err && err.message ? err.message : err)); });
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/;

// A fake adapter with the same surface as desktop/adapter.js. It records
// every call; files is the set of names already in the folder, so the
// counter rule can be checked from the page's side.
function fakeNative({ saved = null, pick = { name: 'Build_Test_1' }, failPick = false, failForget = false, failWrite = false, failDownload = false, downloadAnswer = null } = {}) {
  const calls = [];
  const files = new Set();
  let quit = null;
  let folder = saved;
  return {
    calls,
    files,
    quit: () => quit(),
    hasQuit: () => typeof quit === 'function',
    api: {
      pickFolder: async () => { calls.push(['pickFolder']); if (failPick) throw new Error('Could not remember the folder'); if (pick) folder = pick; return pick; },
      savedFolder: async () => { calls.push(['savedFolder']); return folder; },
      // As the app does (folder.rs): a failed forget changes nothing, on disk or in memory (DM-220).
      forgetFolder: async () => { calls.push(['forgetFolder']); if (failForget) throw new Error('Could not forget the folder'); folder = null; },
      writeTextFile: async (base, ext, text) => {
        calls.push(['writeTextFile', base, ext, text]);
        if (failWrite) throw new Error('disk full');
        let name = base + ext;
        for (let n = 2; files.has(name); n++) name = base + ' (' + n + ')' + ext;
        files.add(name);
        return name;
      },
      saveDownload: async (name, text) => {
        calls.push(['saveDownload', name, text]);
        if (failDownload) throw new Error('Could not save the file: Operation not permitted');
        return downloadAnswer || name;
      },
      onQuit: (callback) => { calls.push(['onQuit']); quit = callback; }
    }
  };
}

async function loadPage({ native = null, storage = {} } = {}) {
  const errors = [];
  const downloads = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));
  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.Math.random = () => 1;   // no simulated typos
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.URL.createObjectURL = (blob) => { downloads.push({ blob, name: null }); return 'blob:http://localhost/' + downloads.length; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { const d = downloads[downloads.length - 1]; if (d) d.name = this.download; };
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      if (native) Object.defineProperty(window, 'PlainSightNative', { value: Object.freeze(native.api), configurable: false });
    }
  });
  const w = dom.window;
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);
  // jsdom does not run module scripts: hand the page its cover the way the
  // page's loader does, and answer its requests for another cover.
  const cover = async (id) => (await import(pathToFileURL(path.join(ROOT, 'covers', id + '.js')).href)).default;
  d.addEventListener('plainsight:select', async (e) => w.PlainSight.setCover(await cover(e.detail.id)));
  w.PlainSight.setCover(await cover(w.PlainSight.selectedCoverId()));
  await w.PlainSight.ready;
  await sleep(0);
  const page = {
    w, d, $, errors, downloads,
    press(key, init = {}) {
      const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      (d.activeElement || d.body).dispatchEvent(ev);
    },
    type(str) { for (const ch of str) page.press(ch); },
    async real() {
      page.press('G', { ctrlKey: true, shiftKey: true });
      const text = $('#real').textContent;
      page.press('G', { ctrlKey: true, shiftKey: true });
      return text;
    },
    toast: () => $('#toast').textContent,
    start() { $('#btn-start').click(); },
    async settle(ms = 30) { await sleep(ms); },
    close() { w.close(); }
  };
  return page;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// The page's Open button, as the file panel would answer it.
function chooseFile(p, file) {
  const input = p.$('#file-input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new p.w.Event('change', { bubbles: true }));
}
const pick = (p, group, value) => {
  const radio = p.$('input[name="' + group + '"][value="' + value + '"]');
  radio.checked = true;
  radio.dispatchEvent(new p.w.Event('change', { bubbles: true }));
};

test('without the adapter the page keeps its browser wording and registers nothing', async () => {
  const p = await loadPage();
  try {
    assert.match(p.$('#vault-on').parentElement.textContent, /in this browser/);
    assert.match(p.$('#folder-note').textContent, /Folder access exists in Chrome/);
    assert.ok(p.d.querySelectorAll('[data-app]').length >= 6, 'the app wording is carried in data-app attributes');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('with the adapter the folder box offers the system picker, no browser help, and the app wording', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    await p.settle();
    assert.equal(p.$('#btn-folder').hidden, false, 'the folder button shows in the app');
    assert.equal(p.$('#folder-help').hidden, true, 'no browser-specific help in the app');
    assert.equal(p.$('#folder-note').textContent.includes('Chrome'), false, 'the browser sentence is gone');
    assert.match(p.$('#folder-note').textContent, /straight into that folder\. Plain means anyone who can open the file can read it\.\s*$/);
    assert.match(p.$('#vault-on').parentElement.textContent, /Save my text on this computer, encrypted/);
    assert.match(p.$('#intro').textContent, /Nothing you type leaves this app/);
    assert.match(p.$('#intro').textContent, /Closing the window or quitting erases the hidden text/);
    assert.match(p.$('#intro').textContent, /clears itself after 10 minutes with its window minimized or hidden/);
    assert.match(p.$('#intro').textContent, /Stored only on this computer\./);
    assert.equal(p.$('#intro').textContent.includes('browser'), false, 'no sentence of the intro mentions a browser');
    assert.equal(p.$('#intro').textContent.includes('tab'), false, 'no sentence of the intro mentions a tab');
    assert.deepEqual(native.calls.filter((c) => c[0] === 'onQuit').length, 1, 'the quit hook is registered once');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('choosing a folder and pressing Save writes the text through the adapter, named by the moment, no password', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    p.start();
    p.type('first line of the real text');
    p.$('#btn-help').click();
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.toast(), 'Save now writes into Build_Test_1');
    assert.equal(p.$('#folder-status').textContent, 'Save writes a plain text file into the folder "Build_Test_1".');
    assert.equal(p.$('#btn-folder-forget').hidden, false);
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 0, 'a picked folder is kept, not forgotten');
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    const writes = native.calls.filter((c) => c[0] === 'writeTextFile');
    assert.equal(writes.length, 1);
    assert.match(writes[0][1], STAMP, 'the base name is the moment of the click, without the extension');
    assert.equal(writes[0][2], '.txt', '.txt unless another format is picked');
    assert.equal(writes[0][3], 'first line of the real text');
    assert.equal(p.toast(), 'Saved ' + writes[0][1] + '.txt in Build_Test_1');
    assert.equal(p.$('#pw').hidden, true, 'no password is asked');
    assert.equal(p.downloads.length, 0, 'nothing is downloaded');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('two saves in the same second keep both files: the adapter\'s counter name reaches the toast', async () => {
  const native = fakeNative({ saved: { name: 'Notes' } });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('same second');
    p.$('#btn-save').click();
    p.$('#btn-save').click();
    await p.settle();
    const writes = native.calls.filter((c) => c[0] === 'writeTextFile');
    assert.equal(writes.length, 2);
    assert.equal(writes[0][1], writes[1][1], 'both saves carry the same moment');
    assert.equal(p.toast(), 'Saved ' + writes[0][1] + ' (2).txt in Notes');
    assert.deepEqual([...native.files], [writes[0][1] + '.txt', writes[0][1] + ' (2).txt']);
  } finally { p.close(); }
});

test('a folder remembered by the app is used after a relaunch, without asking again', async () => {
  const native = fakeNative({ saved: { name: 'Build_Test_1' } });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    assert.ok(native.calls.some((c) => c[0] === 'savedFolder'));
    p.type('after a relaunch');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(native.calls.filter((c) => c[0] === 'pickFolder').length, 0, 'no picker');
    assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 1);
    assert.match(p.toast(), /^Saved \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt in Build_Test_1$/);
  } finally { p.close(); }
});

test('a cancelled picker changes nothing and forgets nothing', async () => {
  const native = fakeNative({ saved: { name: 'Kept' }, pick: null });
  const p = await loadPage({ native });
  try {
    await p.settle();
    const before = p.$('#folder-status').textContent;
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.$('#folder-status').textContent, before);
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 0, 'the remembered folder is not forgotten');
    assert.equal(p.toast(), '', 'no toast');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a folder the app could not keep says so and changes nothing', async () => {
  const native = fakeNative({ saved: { name: 'Kept' }, failPick: true });
  const p = await loadPage({ native });
  try {
    await p.settle();
    const before = p.$('#folder-status').textContent;
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.toast(), 'Could not use that folder');
    assert.equal(p.$('#folder-status').textContent, before, 'the status still names the folder in use');
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 0);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('when the app cannot forget the folder, the page says so and keeps using it, so Save and the screen agree', async () => {
  const native = fakeNative({ saved: { name: 'Build_Test_1' }, failForget: true });
  const p = await loadPage({ native });
  try {
    await p.settle();
    p.start();
    p.type('still in the folder');
    p.$('#btn-help').click();
    const before = p.$('#folder-status').textContent;
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.equal(p.toast(), 'Could not stop using the folder');
    assert.equal(p.$('#folder-status').textContent, before, 'the status still names the folder');
    assert.equal(p.$('#btn-folder-forget').hidden, false, 'the button to stop is still there');
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no password: Save still writes into the folder');
    assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 1, 'the text went into the folder');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('"Stop using the folder" forgets it in the app and Save downloads again', async () => {
  const native = fakeNative({ saved: { name: 'Build_Test_1' } });
  const p = await loadPage({ native });
  try {
    await p.settle();
    p.start();
    p.type('back to the download');
    p.$('#btn-help').click();
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.equal(native.calls.filter((c) => c[0] === 'forgetFolder').length, 1);
    assert.equal(p.$('#folder-status').textContent, 'Save downloads an encrypted .sight file.');
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.$('#pw').hidden, false, 'Save asks for a password for the download again');
    assert.equal(native.calls.filter((c) => c[0] === 'writeTextFile').length, 0);
  } finally { p.close(); }
});

test('a failed write shows a toast and keeps the text', async () => {
  const native = fakeNative({ saved: { name: 'Full' }, failWrite: true });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('not lost');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.toast(), 'Could not write to the folder');
    assert.equal(await p.real(), 'not lost');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('quitting erases the text and the screen like Esc', async () => {
  const native = fakeNative();
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('gone on quit');
    assert.ok(p.$('#cover').textContent.length > 0);
    await native.quit();
    assert.equal(await p.real(), '', 'the hidden text is erased');
    assert.equal(p.$('#cover').textContent, '', 'the screen is erased');
  } finally { p.close(); }
});

test('quitting with the vault open writes the last text, locks the vault and settles after the write', async () => {
  const native = fakeNative();
  const p = await loadPage({ native });
  try {
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    await p.settle(600);   // key derivation and the first write
    assert.ok(p.d.body.classList.contains('vault-open'));
    p.type('typed just before quitting');
    await native.quit();   // no autosave has run yet: the quit itself must write
    assert.ok(!p.d.body.classList.contains('vault-open'), 'the vault is locked');
    const record = JSON.parse(p.w.localStorage.getItem('plainSight.vault'));
    const key = await webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: Buffer.from(record.salt, 'base64'), iterations: record.iterations, hash: 'SHA-256' },
      await webcrypto.subtle.importKey('raw', new TextEncoder().encode('correct horse battery staple'), 'PBKDF2', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') }, key, Buffer.from(record.data, 'base64')));
    assert.equal(plain, 'typed just before quitting', 'the copy holds the last keystrokes when the quit promise settles');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('in the app the plain .txt Save goes through the app, and the toast names the file the app wrote', async () => {
  const native = fakeNative({ downloadAnswer: 'numbered by the app (2).txt' });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', 'plainSight.saveMode': 'txt' } });
  try {
    await p.settle();
    p.type('plain words');
    p.$('#btn-save').click();
    await p.settle();
    const saves = native.calls.filter((c) => c[0] === 'saveDownload');
    assert.equal(saves.length, 1);
    assert.match(saves[0][1], /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
    assert.equal(saves[0][2], 'plain words');
    assert.equal(p.toast(), 'Saved numbered by the app (2).txt', 'the toast names what the app wrote');
    assert.equal(p.downloads.length, 0, 'no browser download in the app');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('in the app the encrypted Save goes through the app after the password, as a .sight file that opens with it', async () => {
  const native = fakeNative();
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.type('secret words');
    p.$('#btn-save').click();
    await p.settle();
    p.$('#pw-input').value = 'a file password';
    p.$('#pw-ok').click();
    await p.settle(800);   // the key derives from the password
    const saves = native.calls.filter((c) => c[0] === 'saveDownload');
    assert.equal(saves.length, 1);
    assert.match(saves[0][1], /^untitled-draft-\d{8}-\d{4}\.sight$/);
    const record = JSON.parse(saves[0][2]);
    const key = await webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: Buffer.from(record.salt, 'base64'), iterations: record.iterations, hash: 'SHA-256' },
      await webcrypto.subtle.importKey('raw', new TextEncoder().encode('a file password'), 'PBKDF2', false, ['deriveKey']),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const plain = new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') }, key, Buffer.from(record.data, 'base64')));
    assert.equal(plain, 'secret words');
    assert.equal(p.toast(), 'Saved');
    assert.equal(p.downloads.length, 0);
  } finally { p.close(); }
});

test('in the app a Save the app could not write says so, in both modes, and never says Saved (DM-202)', async () => {
  for (const mode of ['txt', 'sight']) {
    const native = fakeNative({ failDownload: true });
    const storage = { 'plainSight.introSeen': '1' };
    if (mode === 'txt') storage['plainSight.saveMode'] = 'txt';
    const p = await loadPage({ native, storage });
    try {
      await p.settle();
      p.type('not written');
      p.$('#btn-save').click();
      await p.settle();
      if (mode === 'sight') {
        p.$('#pw-input').value = 'a file password';
        p.$('#pw-ok').click();
        await p.settle(800);
      }
      assert.equal(native.calls.filter((c) => c[0] === 'saveDownload').length, 1, mode + ': the app was asked');
      assert.equal(p.toast(), 'Could not save', mode + ': the failure is told');
      assert.equal(await p.real(), 'not written', mode + ': the text stays');
      assert.deepEqual(unhandled, [], mode + ': the page handled the failure itself');
    } finally { p.close(); }
  }
});

test('in the app the folder formats reach the app as text: .md as it is, and .docx for the app to make (folder.rs)', async () => {
  const native = fakeNative({ saved: { name: 'Notes' } });
  const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1' } });
  try {
    await p.settle();
    p.$('#btn-help').click();
    assert.equal(p.$('#folder-format').hidden, false, 'the folder formats are offered in the app');
    pick(p, 'folder-format', 'md');
    assert.equal(p.$('#folder-status').textContent, 'Save writes a Markdown file into the folder "Notes".');
    p.start();
    p.type('# a heading');
    p.$('#btn-save').click();
    await p.settle();
    p.$('#btn-help').click();
    pick(p, 'folder-format', 'docx');
    p.start();
    p.press('Tab');
    p.type('tabbed');
    p.$('#btn-save').click();
    await p.settle();
    const writes = native.calls.filter((c) => c[0] === 'writeTextFile');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.map((c) => c.slice(2)), [['.md', '# a heading'], ['.docx', '# a heading\ttabbed']], 'the extension and the text, never a file of bytes');
    assert.equal(typeof writes[1][3], 'string', 'the app makes the Word document itself');
    assert.equal(p.toast(), 'Saved ' + writes[1][1] + '.docx in Notes');
    assert.equal(p.downloads.length, 0, 'nothing is downloaded');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('in the app a .md or .docx download reaches the app as text, named by the moment', async () => {
  for (const mode of ['md', 'docx']) {
    const native = fakeNative();
    const p = await loadPage({ native, storage: { 'plainSight.introSeen': '1', 'plainSight.saveMode': mode } });
    try {
      await p.settle();
      p.type('plain words');
      p.$('#btn-save').click();
      await p.settle();
      const saves = native.calls.filter((c) => c[0] === 'saveDownload');
      assert.equal(saves.length, 1, mode);
      assert.match(saves[0][1], new RegExp('^\\d{4}-\\d{2}-\\d{2} \\d{2}-\\d{2}-\\d{2}\\.' + mode + '$'), mode + ': named by the moment');
      assert.equal(saves[0][2], 'plain words', mode + ': the text, not a file of bytes');
      assert.equal(p.toast(), 'Saved ' + saves[0][1], mode);
      assert.equal(p.downloads.length, 0, mode + ': no browser download in the app');
      assert.deepEqual(p.errors, [], mode);
    } finally { p.close(); }
  }
});

test('the page makes, byte for byte, the Word document the app is held to (tests/fixtures, docx.rs)', async () => {
  const sample = readFileSync(path.join(ROOT, 'desktop/tests/fixtures/sample.txt'), 'utf8');
  const expected = readFileSync(path.join(ROOT, 'desktop/tests/fixtures/sample.docx'));
  const p = await loadPage({ storage: { 'plainSight.introSeen': '1', 'plainSight.saveMode': 'docx' } });
  try {
    await p.settle();
    chooseFile(p, new p.w.File([sample], 'sample.txt', { type: 'text/plain' }));
    await p.settle();
    assert.equal(await p.real(), sample, 'the sample opened as it is');
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.downloads.length, 1);
    assert.match(p.downloads[0].name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.docx$/);
    const bytes = Buffer.from(await p.downloads[0].blob.arrayBuffer());
    assert.ok(bytes.equals(expected), 'the same bytes as tests/fixtures/sample.docx (' + bytes.length + ' and ' + expected.length + ' bytes)');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed += 1;
    console.log('ok   - ' + t.name);
  } catch (err) {
    failed += 1;
    console.log('FAIL - ' + t.name);
    console.log('       ' + String(err && err.stack ? err.stack : err).split('\n').join('\n       '));
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
