// Smoke test for Plain Sight. Runs the real index.html in jsdom and drives it
// through the DOM: keyboard events, the header, the dialogs, the download
// path and the public console API. Nothing reaches into the page's closure.
//
// Run with: npm test   (exit code 0 only when every test passes)

import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const UNLOCK_WINDOW_MS = 2000;
const VAULT_SAVE_DELAY_MS = 1500;
const TEN_MINUTES = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Page harness
// ---------------------------------------------------------------------------
// jsdom does not execute <script type="module">, so the harness plays the part
// of the page's cover loader: it imports covers/<id>.js in node (which also
// proves the file is a valid ES module) and hands the object to
// PlainSight.setCover(), exactly as the bridge script does, and it answers the
// same plainsight:select event when the page asks for another cover.
async function importCover(id) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'covers', id + '.js')).href);
  return mod.default;
}

async function loadPage({ random = () => 1, storage = {}, inject = true, folder = null } = {}) {
  const errors = [];
  const downloads = [];
  const copied = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (...args) => errors.push('console.error: ' + args.join(' ')));

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      // Deterministic typos: Math.random() === 1 means "never a typo".
      window.Math.random = random;
      // jsdom has no crypto.subtle, URL.createObjectURL or navigator.clipboard.
      Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true });
      window.URL.createObjectURL = (blob) => { downloads.push({ blob, name: null }); return 'blob:http://localhost/' + downloads.length; };
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () {
        const d = downloads[downloads.length - 1];
        if (d && this.href === 'blob:http://localhost/' + downloads.length) d.name = this.download;
      };
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async (text) => { copied.push(text); } },
        configurable: true
      });
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      // A fake File System Access API: a directory picker that hands back a
      // folder whose files are recorded in folder.written.
      if (folder) {
        window.showDirectoryPicker = async () => {
          if (folder.cancel) throw new window.DOMException('The user aborted a request.', 'AbortError');
          return folder.handle;
        };
      }
    }
  });

  const w = dom.window;
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);

  const loads = [];
  const failCovers = new Set();   // ids whose load the harness should fail on purpose
  async function loadCover(id) {
    loads.push(id);
    if (failCovers.has(id)) { w.PlainSight.coverFailed(id); return; }
    try { w.PlainSight.setCover(await importCover(id)); } catch (err) { w.PlainSight.coverFailed(id); }
  }
  d.addEventListener('plainsight:select', (e) => { loadCover(e.detail.id); });
  if (inject) {
    await loadCover(w.PlainSight.selectedCoverId());
    await w.PlainSight.ready;
  }

  const page = {
    w, d, $, errors, downloads, copied, loads, loadCover, failCovers,
    press(key, init = {}, target = null) {
      const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
      (target || d.activeElement || d.body).dispatchEvent(ev);
      return ev.defaultPrevented;
    },
    release(key) {
      d.body.dispatchEvent(new w.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    },
    type(str) { for (const ch of str) page.press(ch); },
    coverText() { return $('#cover').textContent; },
    // Cover characters on screen. A paragraph break is a keystroke's worth of
    // cover, so it counts as one character.
    coverLength() {
      const blocks = page.blocks();
      return blocks.reduce((n, b) => n + b.text.length, 0) + Math.max(0, blocks.length - 1);
    },
    // Blocks in screen order. Bullets live inside a shared ul, so they are
    // listed as the li elements themselves.
    blocks() {
      return Array.from($('#cover').querySelectorAll(':scope > p, :scope > h2, :scope > ul > li'))
        .map((el) => ({ type: el.classList.contains('ref') ? 'ref' : el.tagName.toLowerCase(), text: el.textContent }));
    },
    peeking() { return d.body.classList.contains('peek'); },
    // Ctrl+Shift+G toggles the peek. peek() turns it on and reads the real
    // text off the screen; readReal() reads it and turns the peek off again.
    peekChord() { return page.press('G', { ctrlKey: true, shiftKey: true }); },
    async peek() {
      if (!page.peeking()) page.peekChord();
      return $('#real').textContent;
    },
    async readReal() {
      const text = await page.peek();
      page.peekChord();
      return text;
    },
    unlockChord() {
      const armed = page.press('e', { ctrlKey: true });
      const fired = page.press('Enter', { ctrlKey: true });
      return { armed, fired };
    },
    storageDump() {
      const ls = page.w.localStorage;
      const out = {};
      for (let i = 0; i < ls.length; i++) { const k = ls.key(i); out[k] = ls.getItem(k); }
      return out;
    },
    // Turns the device vault on through the intro screen.
    async vaultOn(phrase) {
      if ($('#intro').hidden) $('#btn-help').click();
      $('#vault-on').checked = true;
      $('#vault-on').dispatchEvent(new w.Event('change', { bubbles: true }));
      $('#vault-phrase').value = phrase;
      page.start();
      await sleep(400);   // key derivation and the first save
    },
    wordCount() { return $('#word-count').textContent; },
    toast() { return $('#toast').textContent; },
    start() { $('#btn-start').click(); },
    async submitPassword(value) {
      assert.equal($('#pw').hidden, false, 'password dialog should be open');
      $('#pw-input').value = value;
      $('#pw-ok').click();
      await sleep(0);
    },
    async settle(ms = 50) { await sleep(ms); },
    close() { w.close(); }
  };
  return page;
}

// Reference model of the cover display after n keystrokes with no typos.
// Mirrors the engine's rules so the tests can state expectations without
// hard-coding the story: markers are consumed at a block start, '\n' is a
// paragraph break, the end of the text is a break followed by a loop.
const MARKERS = [
  { prefix: '## ', type: 'h2' },
  { prefix: '- ', type: 'li' },
  { pattern: /^\[\d+\] /, type: 'ref' }   // typed as text, styled as a reference entry
];
function expectedBlocks(coverText, n) {
  const blocks = [];
  let pos = 0;
  const start = () => {
    let type = 'p';
    for (const m of MARKERS) {
      if (m.prefix && coverText.startsWith(m.prefix, pos)) { pos += m.prefix.length; type = m.type; break; }
      if (m.pattern && m.pattern.test(coverText.slice(pos, pos + 16))) { type = m.type; break; }
    }
    blocks.push({ type, text: '' });
  };
  start();
  for (let i = 0; i < n; i++) {
    if (pos >= coverText.length) { pos = 0; start(); continue; }
    const ch = coverText[pos];
    if (ch === '\n') { pos += 1; start(); continue; }
    blocks[blocks.length - 1].text += ch;
    pos += 1;
  }
  return blocks;
}
function countWords(blocks) {
  return blocks.reduce((n, b) => n + (b.text.match(/\S+/g) || []).length, 0);
}
// Decrypts a stored vault record outside the page, to prove what the page saved.
async function decryptVault(record, phrase) {
  const salt = Buffer.from(record.salt, 'base64');
  const iv = Buffer.from(record.iv, 'base64');
  const data = Buffer.from(record.data, 'base64');
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(phrase), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: record.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data));
}
function fakeFolder(name, { permission = 'granted' } = {}) {
  const written = [];
  const handle = {
    kind: 'directory',
    name,
    queryPermission: async () => permission,
    requestPermission: async () => permission,
    getFileHandle: async (fileName, opts) => ({
      createWritable: async () => ({
        write: async (text) => { written.push({ name: fileName, text, create: Boolean(opts && opts.create) }); },
        close: async () => {}
      })
    })
  };
  return { handle, written, cancel: false };
}
function makeCoverFile(w, json) {
  return new w.File([json], 'test.sight', { type: 'application/json' });
}
function chooseFile(page, file) {
  const input = page.$('#file-input');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new page.w.Event('change', { bubbles: true }));
}

// ---------------------------------------------------------------------------
// Tiny runner
// ---------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test('inline scripts parse with node --check', () => {
  const scripts = [...HTML.matchAll(/<script(?:\s+type="module")?>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 1, 'expected at least one inline script');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cover-story-check-'));
  try {
    scripts.forEach((m, i) => {
      const isModule = m[0].startsWith('<script type="module"');
      const file = path.join(dir, `script-${i}.${isModule ? 'mjs' : 'cjs'}`);
      writeFileSync(file, m[1]);
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('first visit: intro shows, Start hides it, book cover loaded, empty page', async () => {
  const p = await loadPage();
  try {
    assert.equal(p.$('#intro').hidden, false, 'intro visible on first visit');
    assert.equal(p.w.localStorage.getItem('plainSight.introSeen'), null);
    p.start();
    assert.equal(p.$('#intro').hidden, true, 'intro hidden after Start');
    assert.equal(p.w.localStorage.getItem('plainSight.introSeen'), '1');
    assert.equal(p.d.title, 'Untitled draft');
    assert.ok(p.d.body.classList.contains('font-serif'));
    assert.equal(p.$('#header-left').textContent, 'Untitled draft');
    assert.equal(p.wordCount(), '0 words');
    assert.equal(p.coverText(), '');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: '' }], 'the story opens with a chapter heading block');
    assert.equal(p.w.PlainSight.coverId(), 'book', 'the cover loaded is book');
    assert.deepEqual(p.loads, ['book'], 'exactly one cover load was requested');
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'book', 'the selection persists');
    assert.equal(p.$('#load-notice').hidden, true);
    assert.ok(p.w.PlainSight.coverText().length > 1500, 'cover text present');
    assert.equal(p.$('#cover').querySelector('.caret').textContent, '', 'caret adds no text');
    assert.equal(p.$('#intro-title').textContent, 'Plain Sight');
    assert.equal(p.$('#vault-on').checked, false, 'the device vault is off by default');
    assert.equal(p.$('#vault-phrase').disabled, true);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('typing N printable keys renders exactly N cover characters; real buffer equals what was typed; no peek class', async () => {
  const p = await loadPage();
  try {
    p.start();
    const typed = 'The quick brown fox jumps over the lazy dog, twice; 42!'.slice(0, 40);
    assert.equal(typed.length, 40);
    for (const ch of typed) assert.equal(p.press(ch), true, 'printable key is preventDefaulted');
    assert.equal(p.coverLength(), 40, 'exactly N cover characters');
    const expected = expectedBlocks(p.w.PlainSight.coverText(), 40);
    assert.deepEqual(p.blocks(), expected);
    assert.equal(p.peeking(), false, 'peek class absent after typing');
    assert.equal(await p.readReal(), typed, 'real buffer equals what was typed');
    assert.equal(p.peeking(), false, 'the second chord ends the peek');
    assert.equal(p.$('#real').textContent, '', 'real text removed from the page after peek');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Backspace shortens both buffers by one', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('abcdefghij');
    for (let i = 0; i < 3; i++) assert.equal(p.press('Backspace'), true);
    assert.equal(p.coverLength(), 7);
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 7));
    assert.equal(await p.readReal(), 'abcdefg');
    // Backspace on an empty page is harmless.
    for (let i = 0; i < 10; i++) p.press('Backspace');
    assert.equal(p.coverText(), '');
    assert.equal(await p.readReal(), '');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Esc empties both buffers', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('some secret words here');
    assert.equal(p.press('Escape'), true);
    assert.equal(p.coverText(), '');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: '' }]);
    assert.equal(p.wordCount(), '0 words');
    assert.equal(await p.readReal(), '');
    // Typing after a wipe starts the cover from the top again.
    p.type('xy');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 2));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Enter and Tab are recorded and advance one cover character; Shift+Tab is left to the browser', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('ab');
    assert.equal(p.press('Enter'), true);
    assert.equal(p.press('Tab'), true);
    assert.equal(p.coverLength(), 4);
    assert.equal(await p.readReal(), 'ab\n\t');
    assert.equal(p.press('Tab', { shiftKey: true }), false, 'Shift+Tab not prevented');
    assert.equal(p.coverLength(), 4);
    assert.equal(await p.readReal(), 'ab\n\t');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('keys with Ctrl, Cmd or Alt held are not recorded and not prevented; isComposing events are ignored', async () => {
  const p = await loadPage();
  try {
    p.start();
    assert.equal(p.press('b', { ctrlKey: true }), false);
    assert.equal(p.press('b', { metaKey: true }), false);
    assert.equal(p.press('b', { altKey: true }), false);
    assert.equal(p.press('s', { metaKey: true }), false, 'Cmd+S goes to the browser');
    assert.equal(p.press('e', { ctrlKey: true }), false, 'Ctrl+E goes to the browser while no vault exists');
    assert.equal(p.press('Enter', { ctrlKey: true }), false, 'Ctrl+Enter goes to the browser while no vault exists');
    assert.equal(p.press('a', { isComposing: true }), false);
    assert.equal(p.press('Enter', { isComposing: true }), false);
    assert.equal(p.coverText(), '');
    assert.equal(await p.readReal(), '');
    // Arrow keys and Shift alone are left alone too.
    assert.equal(p.press('ArrowLeft'), false);
    assert.equal(p.press('Shift', { shiftKey: true }), false);
    assert.equal(p.coverText(), '');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Ctrl+Shift+G toggles the peek; typing, a window blur and a hidden tab end it; Cmd+Shift+G works too', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('hidden text');
    assert.equal(p.peeking(), false);
    assert.equal(p.press('G', { ctrlKey: true, shiftKey: true }), true, 'the chord is handled');
    assert.equal(p.peeking(), true, 'peek on');
    assert.equal(p.$('#real').textContent, 'hidden text');
    assert.equal(p.press('G', { ctrlKey: true, shiftKey: true }), true);
    assert.equal(p.peeking(), false, 'peek off again');
    assert.equal(p.$('#real').textContent, '', 'real text removed from the page');
    // Typing ends a peek and is still recorded.
    p.peekChord();
    assert.equal(p.peeking(), true);
    p.type('!');
    assert.equal(p.peeking(), false, 'typing ends the peek');
    assert.equal(p.$('#real').textContent, '');
    // Backspace ends it too.
    p.peekChord();
    p.press('Backspace');
    assert.equal(p.peeking(), false);
    // A window blur (for example Cmd+Tab away) ends it.
    p.press('g', { metaKey: true, shiftKey: true });
    assert.equal(p.peeking(), true, 'Cmd+Shift+G peeks too');
    p.w.dispatchEvent(new p.w.Event('blur'));
    assert.equal(p.peeking(), false, 'blur ends peek');
    // Holding Ctrl on its own no longer does anything.
    p.press('Control', { ctrlKey: true });
    await sleep(1100);
    assert.equal(p.peeking(), false, 'a held modifier never peeks');
    p.release('Control');
    // Ctrl+G without Shift is the browser's.
    assert.equal(p.press('g', { ctrlKey: true }), false);
    assert.equal(p.peeking(), false);
    assert.equal(await p.readReal(), 'hidden text');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
test('Ctrl+C while peeking copies the real text; Ctrl+C otherwise is left to the browser', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('copy me');
    assert.equal(p.press('c', { ctrlKey: true }), false, 'not peeking: browser copy');
    assert.deepEqual(p.copied, []);
    await p.peek();
    assert.equal(p.press('c', { ctrlKey: true }), true, 'peeking: handled');
    await p.settle();
    assert.deepEqual(p.copied, ['copy me']);
    assert.equal(p.toast(), 'Copied');
    assert.equal(await p.$('#real').textContent, 'copy me', 'still peeking, buffer intact');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('simulated typo: a wrong neighbouring letter appears at a word start and the next keystroke removes it', async () => {
  const p = await loadPage({ random: () => 0 });   // 0 < 3.5 percent: typo on every word start
  try {
    p.start();
    const text = p.w.PlainSight.coverText();
    const expected1 = expectedBlocks(text, 1);
    const correct = expected1[expected1.length - 1].text;   // the first real cover letter
    p.press('a');
    assert.equal(p.coverLength(), 1, 'one character on screen');
    assert.notEqual(p.coverText(), correct, 'and it is the wrong one');
    assert.match(p.coverText(), /^[A-Za-z]$/);
    p.press('b');
    assert.equal(p.coverLength(), 0, 'the correcting keystroke removes it');
    p.press('c');
    assert.deepEqual(p.blocks(), expected1, 'then the right letter appears');
    p.type('def');   // inside the word: no typos
    assert.deepEqual(p.blocks(), expectedBlocks(text, 4));
    assert.equal(await p.readReal(), 'abcdef', 'the real buffer has every keystroke');
    // Backspace while a wrong letter is pending removes it and one real character.
    p.press(' ');   // the next paragraph starts here: another word start, another typo
    assert.equal(p.blocks().length, 2);
    assert.equal(p.blocks()[1].text.length, 1);
    assert.notEqual(p.blocks()[1].text, expectedBlocks(text, 5)[1].text, 'wrong letter pending');
    p.press('Backspace');
    assert.deepEqual(p.blocks(), expectedBlocks(text, 4));
    assert.equal(await p.readReal(), 'abcdef');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('custom cover text from localStorage is used; when it runs out the cover breaks a paragraph and loops', async () => {
  const p = await loadPage({ storage: { 'plainSight.customText': 'ab cd', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.$('#intro').hidden, true, 'intro not shown on a return visit');
    assert.equal(p.w.PlainSight.coverText(), 'ab cd');
    p.type('1234567');
    assert.deepEqual(p.blocks(), [{ type: 'p', text: 'ab cd' }, { type: 'p', text: 'a' }]);
    assert.deepEqual(expectedBlocks('ab cd', 7), p.blocks(), 'reference model agrees on a hand-checked case');
    assert.equal(p.wordCount(), '3 words');
    p.press('Backspace');
    p.press('Backspace');
    assert.deepEqual(p.blocks(), [{ type: 'p', text: 'ab cd' }], 'Backspace undoes the paragraph break');
    assert.equal(p.wordCount(), '2 words');
    assert.equal(await p.readReal(), '12345');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a cover line starting with ## renders as a heading; the marker costs no keystrokes; Backspace walks back through it', async () => {
  const p = await loadPage({ storage: { 'plainSight.customText': '## Title\n\nBody text', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.coverText(), '## Title\nBody text');
    p.type('12345');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }]);
    p.type('6');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }, { type: 'p', text: '' }]);
    p.type('7890');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }, { type: 'p', text: 'Body' }]);
    assert.equal(p.wordCount(), '2 words');
    for (let i = 0; i < 5; i++) p.press('Backspace');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: 'Title' }]);
    assert.equal(await p.readReal(), '12345');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the word count counts the cover text on screen, not the real text', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('aaaaaaaaaaaaaaaaaaaa');   // one real word, 20 keystrokes
    const expected = countWords(expectedBlocks(p.w.PlainSight.coverText(), 20));
    assert.ok(expected > 1, 'the first 20 cover characters hold more than one word');
    assert.equal(p.wordCount(), expected + ' words');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Save writes a .sight with a 16-byte salt, 12-byte IV and data; Open restores it with the right password and refuses wrong passwords, damaged files, foreign formats and bad iteration counts with a toast', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('hello world');
    const save = async (password) => {
      const before = p.downloads.length;
      p.$('#btn-save').click();
      await p.submitPassword(password);
      await p.settle(400);
      assert.equal(p.downloads.length, before + 1, 'one download per save');
      return p.downloads[before].blob.text();
    };
    const open = async (fileText, password) => {
      chooseFile(p, makeCoverFile(p.w, fileText));
      await p.settle();
      if (p.$('#pw').hidden) return p.toast();   // refused before the password prompt
      await p.submitPassword(password);
      await p.settle(400);
      return p.toast();
    };
    const json = await save('correct horse');
    const f = JSON.parse(json);
    assert.equal(f.format, 'plain-sight');
    assert.equal(f.version, 1);
    assert.equal(f.cipher, 'AES-256-GCM');
    assert.equal(f.kdf, 'PBKDF2-SHA-256');
    assert.equal(f.iterations, 310000);
    assert.equal(Buffer.from(f.salt, 'base64').length, 16);
    assert.equal(Buffer.from(f.iv, 'base64').length, 12);
    assert.equal(Buffer.from(f.data, 'base64').length, 'hello world'.length + 16, 'ciphertext plus the 16-byte GCM tag');
    assert.ok(!json.includes('hello world'), 'plaintext is not in the file');
    const g = JSON.parse(await save('correct horse'));
    assert.notEqual(g.salt, f.salt, 'fresh salt every time');
    assert.notEqual(g.iv, f.iv, 'fresh IV every time');
    // An empty password is not accepted; the dialog stays open until cancelled.
    p.$('#btn-save').click();
    await p.submitPassword('');
    assert.equal(p.$('#pw').hidden, false, 'an empty password is refused');
    p.press('Escape');
    assert.equal(p.$('#pw').hidden, true);

    p.press('Escape');
    assert.equal(await p.readReal(), '');
    assert.equal(await open(json, 'wrong password'), 'Wrong password or damaged file');
    assert.equal(await p.readReal(), '', 'a failed open changes nothing');
    assert.equal(await open(json, 'correct horse'), 'Opened');
    assert.equal(await p.readReal(), 'hello world', 'round trip');
    assert.equal(p.coverLength(), 'hello world'.length, 'the cover is rebuilt to the same length');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 11));

    // Damaged, foreign or hostile files are refused, most of them before any key derivation.
    const variant = (changes) => JSON.stringify({ ...f, ...changes });
    assert.equal(await open('{"salt":1}', 'x'), 'That is not a .sight file');
    assert.equal(await open('not json', 'x'), 'That is not a .sight file');
    assert.equal(await open(variant({ iterations: 50000000 }), 'correct horse'), 'Wrong password or damaged file', 'iteration cap');
    assert.equal(await open(variant({ iterations: 999 }), 'correct horse'), 'Wrong password or damaged file', 'iteration floor');
    assert.equal(await open(variant({ iterations: '310000' }), 'correct horse'), 'That is not a .sight file', 'iterations must be a number');
    assert.equal(await open(variant({ iv: f.salt }), 'correct horse'), 'Wrong password or damaged file', 'IV length');
    assert.equal(await open(variant({ format: 'other' }), 'correct horse'), 'That is not a .sight file');
    assert.equal(await open(variant({ format: 'cover-story' }), 'correct horse'), 'Opened', 'files from the earlier name still open');
    assert.equal(await open(variant({ version: 2 }), 'correct horse'), 'That is not a .sight file');
    assert.equal(await open(variant({ cipher: 'AES-128-GCM' }), 'correct horse'), 'That is not a .sight file');
    assert.equal(await open(variant({ kdf: 'scrypt' }), 'correct horse'), 'That is not a .sight file');
    const bytes = Buffer.from(f.data, 'base64');
    bytes[0] ^= 1;
    assert.equal(await open(variant({ data: bytes.toString('base64') }), 'correct horse'), 'Wrong password or damaged file', 'a flipped ciphertext bit fails authentication');
    assert.equal(await p.readReal(), 'hello world', 'every refusal left the buffer alone');
    // Nothing on the console object touches the buffer.
    assert.deepEqual(Object.keys(p.w.PlainSight).sort(), ['coverFailed', 'coverId', 'coverIds', 'coverText', 'ready', 'selectedCoverId', 'setCover', 'version']);
    assert.equal(p.w.PlainSight.version, '1.2.1');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Save button: password dialog, then a .sight download holding valid JSON; nothing to save shows a toast', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.$('#btn-save').click();
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no dialog when there is nothing to save');
    assert.equal(p.toast(), 'Nothing to save yet');
    p.type('a note');
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false, 'dialog opens');
    // Keys typed into the dialog do not reach the hidden buffer.
    p.press('z', {}, p.$('#pw-input'));
    await p.submitPassword('pw-1234');
    await p.settle(400);
    assert.equal(p.$('#pw').hidden, true);
    assert.equal(p.downloads.length, 1, 'one download');
    assert.match(p.downloads[0].name, /^untitled-draft-\d{8}-\d{4}\.sight$/);
    const f = JSON.parse(await p.downloads[0].blob.text());
    assert.ok(f.salt && f.iv && f.data);
    assert.equal(p.toast(), 'Saved');
    assert.equal(await p.readReal(), 'a note', 'saving keeps the text on the page');
    // Cancel path.
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false);
    assert.equal(p.press('Escape'), true, 'Esc closes the dialog');
    assert.equal(p.$('#pw').hidden, true);
    assert.equal(await p.readReal(), 'a note', 'Esc in a dialog does not wipe');
    assert.equal(p.downloads.length, 1);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Open: wrong password fails with a toast and no console error; right password restores the text', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('first draft');
    p.$('#btn-save').click();
    await p.submitPassword('right');
    await p.settle(400);
    const json = await p.downloads[0].blob.text();
    p.press('Escape');
    p.type('xyz');

    chooseFile(p, makeCoverFile(p.w, json));
    await p.settle();
    await p.submitPassword('wrong');
    await p.settle(400);
    assert.equal(p.toast(), 'Wrong password or damaged file');
    assert.equal(await p.readReal(), 'xyz', 'nothing changed');

    chooseFile(p, makeCoverFile(p.w, json));
    await p.settle();
    await p.submitPassword('right');
    await p.settle(400);
    assert.equal(p.toast(), 'Opened');
    assert.equal(await p.readReal(), 'first draft');
    assert.equal(p.coverLength(), 'first draft'.length);

    chooseFile(p, makeCoverFile(p.w, 'this is not json'));
    await p.settle();
    assert.equal(p.$('#pw').hidden, true, 'no password prompt for a non-cover file');
    assert.equal(p.toast(), 'That is not a .sight file');
    assert.deepEqual(p.errors, [], 'no console errors on any failure path');
  } finally { p.close(); }
});

test('a tab hidden for more than 10 minutes with text in the buffer is wiped on return; a short absence is not', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('do not keep this');
    const realNow = p.w.Date.now();
    let fakeNow = realNow;
    p.w.Date.now = () => fakeNow;
    const setHidden = (hidden) => {
      Object.defineProperty(p.d, 'hidden', { get: () => hidden, configurable: true });
      p.d.dispatchEvent(new p.w.Event('visibilitychange'));
    };
    setHidden(true);
    fakeNow += 60 * 1000;
    setHidden(false);
    assert.equal(p.coverLength(), 'do not keep this'.length, 'one minute away keeps the text');
    setHidden(true);
    fakeNow += TEN_MINUTES + 1000;
    setHidden(false);
    assert.equal(p.coverText(), '', 'cover wiped');
    assert.equal(p.wordCount(), '0 words');
    assert.equal(p.toast(), 'Cleared after 10 minutes in the background');
    assert.equal(await p.readReal(), '', 'real wiped');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('while a dialog is open nothing is recorded, Esc closes the dialog instead of wiping, and the ? button reopens the intro', async () => {
  const p = await loadPage();
  try {
    assert.equal(p.$('#intro').hidden, false);
    p.type('abc');
    assert.equal(p.coverText(), '');
    assert.equal(p.press('Escape'), true);
    assert.equal(p.$('#intro').hidden, true, 'Esc closes the intro');
    p.type('abc');
    assert.equal(p.coverLength(), 3);
    p.$('#btn-help').click();
    assert.equal(p.$('#intro').hidden, false, '? reopens the intro');
    p.type('def');
    p.press('Backspace');
    assert.equal(p.coverLength(), 3, 'keys in the intro do not touch the page');
    // Custom text entered in the intro is applied and remembered on Start.
    p.$('#custom-text').value = 'one two three four five six';
    p.start();
    assert.equal(p.w.localStorage.getItem('plainSight.customText'), 'one two three four five six');
    assert.equal(p.w.PlainSight.coverText(), 'one two three four five six');
    assert.equal(p.coverText(), 'one', 'the screen is rebuilt for the 3 keystrokes already typed');
    assert.equal(await p.readReal(), 'abc');
    // Clearing the box goes back to the built-in text.
    p.$('#btn-help').click();
    p.$('#custom-text').value = '';
    p.start();
    assert.equal(p.w.localStorage.getItem('plainSight.customText'), null);
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 3));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('intro has the three mode radios; book is checked; the selection is written on Start', async () => {
  const p = await loadPage();
  try {
    const radios = Array.from(p.d.querySelectorAll('input[name="mode"]'));
    assert.deepEqual(radios.map((r) => r.value), ['book', 'work', 'paper']);
    assert.deepEqual(radios.map((r) => r.checked), [true, false, false]);
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), null, 'nothing stored before Start');
    p.start();
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'book');
    assert.equal(p.w.PlainSight.selectedCoverId(), 'book');
    assert.deepEqual(p.loads, ['book'], 'picking the cover already on screen requests nothing');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a remembered cover id is used on the next visit; unknown ids fall back to book', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'nonsense', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.selectedCoverId(), 'book');
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('before a cover is on screen typing is ignored and left to the browser; a failed load shows the notice; a bad cover object is refused', async () => {
  const p = await loadPage({ inject: false, storage: { 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.coverId(), null);
    assert.equal(p.press('a'), false, 'not prevented');
    assert.equal(p.press('Escape'), false);
    assert.equal(p.$('#cover').children.length, 0);
    assert.equal(p.$('#load-notice').hidden, true);
    p.w.PlainSight.coverFailed('book');
    assert.equal(p.$('#load-notice').hidden, false, 'notice shown');
    assert.equal(p.toast(), 'Could not load the cover text');
    assert.throws(() => p.w.PlainSight.setCover({ id: 'book', text: 'x' }), /Not a cover object/);
    assert.throws(() => p.w.PlainSight.setCover({ id: 'evil', label: 'x', tabTitle: 'x', font: 'serif', header: { left: 'x', right: [] }, text: 'x' }), /Not a cover object/);
    await p.loadCover('book');
    assert.equal(p.$('#load-notice').hidden, true, 'notice hidden once a cover arrives');
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.equal(p.press('a'), true);
    assert.equal(p.coverLength(), 1);
    assert.equal(await p.readReal(), 'a');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the module bridge imports ./covers/<id>.js for the selected id and listens for plainsight:select', () => {
  const m = HTML.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'module script present');
  const src = m[1];
  assert.ok(src.includes("import('./covers/' + id + '.js')"), 'dynamic import of the cover file');
  assert.ok(src.includes('api.setCover(mod.default)'));
  assert.ok(src.includes("addEventListener('plainsight:select'"));
  assert.ok(src.includes('load(api.selectedCoverId())'), 'initial load uses the remembered selection');
  assert.ok(src.includes('api.coverFailed(id)'), 'failure path reports to the page');
  assert.equal((HTML.match(/<script type="module">/g) || []).length, 1, 'one module script');
  assert.ok(!HTML.includes('fetch(') && !HTML.includes('XMLHttpRequest') && !HTML.includes('sendBeacon') && !HTML.includes('WebSocket'), 'no network APIs in the page');
  assert.ok(!/<script[^>]+src=/.test(HTML), 'no external scripts');
  assert.ok(!/<link[^>]+rel="stylesheet"/.test(HTML), 'no external stylesheets');
});

test('covers/book.js is a valid ES module with the shared shape, at least 1,500 words and chapter headings', async () => {
  const c = await importCover('book');
  assert.equal(c.id, 'book');
  assert.equal(typeof c.label, 'string');
  assert.equal(c.tabTitle, 'Untitled draft');
  assert.equal(c.font, 'serif');
  assert.equal(c.header.left, 'Untitled draft');
  assert.deepEqual(c.header.right, ['word count']);
  const words = (c.text.replace(/^## .*$/gm, '').match(/\S+/g) || []).length;
  assert.ok(words >= 1500, 'at least 1,500 words, got ' + words);
  assert.ok((c.text.match(/^## /gm) || []).length >= 2, 'chapter headings present');
  const src = readFileSync(path.join(ROOT, 'covers', 'book.js'), 'utf8');
  assert.match(src, /fictional/i, 'the file says its names are fictional');
});

test('switching to work loads that cover: sans chrome, static "Last edited just now", a decorative toolbar, no word count', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'work', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.w.PlainSight.coverId(), 'work');
    assert.equal(p.d.title, 'Q3 planning notes');
    assert.equal(p.$('#header-left').textContent, 'Q3 planning notes');
    assert.ok(p.d.body.classList.contains('font-sans') && p.d.body.classList.contains('cover-work'));
    assert.ok(!p.d.body.classList.contains('font-serif') && !p.d.body.classList.contains('cover-book'));
    assert.equal(p.$('#last-edited').textContent, 'Last edited just now');
    assert.equal(p.$('#word-count'), null, 'no word count on the work document');
    const toolbar = p.$('#toolbar');
    assert.equal(toolbar.getAttribute('aria-hidden'), 'true');
    assert.equal(toolbar.querySelectorAll('button, a, input, select').length, 0, 'nothing in the toolbar is a control');
    assert.ok(toolbar.querySelectorAll('.ic').length >= 6, 'icon placeholders present');
    assert.match(HTML, /body\.cover-work \.toolbar \{ display: flex; \}/, 'toolbar shown with the work cover');
    assert.match(HTML, /\.toolbar \{\n\s+display: none;/, 'and hidden otherwise');
    const typed = 'Hello there, typing on the work document now.';
    p.type(typed);
    assert.equal(p.$('#last-edited').textContent, 'Last edited just now', 'the static text does not change');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), typed.length));
    assert.equal(await p.readReal(), typed, 'the real buffer is unaffected by the cover');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a cover line starting with "- " renders inside a list item; bullets share one list; headings render as headings; Backspace walks back out', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'work', 'plainSight.introSeen': '1', 'plainSight.customText': '## Agenda\n- first item\n- second item\n\nClosing line' } });
  try {
    assert.equal(p.w.PlainSight.coverText(), '## Agenda\n- first item\n- second item\nClosing line');
    const h2 = { type: 'h2', text: 'Agenda' };
    p.type('123456');
    assert.deepEqual(p.blocks(), [h2]);
    assert.equal(p.$('#cover > h2').textContent, 'Agenda', 'heading line renders as a heading');
    p.type('7');
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: '' }]);
    assert.equal(p.d.querySelectorAll('#cover > ul > li').length, 1, 'the bullet sits inside a ul');
    p.type('first item');
    p.type('x');
    p.type('second item');
    assert.equal(p.d.querySelectorAll('#cover > ul').length, 1, 'consecutive bullets share one list');
    assert.equal(p.d.querySelectorAll('#cover > ul > li').length, 2);
    p.type('x');
    p.type('Closing');
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: 'first item' }, { type: 'li', text: 'second item' }, { type: 'p', text: 'Closing' }]);
    assert.deepEqual(Array.from(p.$('#cover').children).map((e) => e.tagName), ['H2', 'UL', 'P']);
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 37), 'reference model agrees');
    for (let i = 0; i < 8; i++) p.press('Backspace');     // "Closing" and its break
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: 'first item' }, { type: 'li', text: 'second item' }]);
    assert.deepEqual(Array.from(p.$('#cover').children).map((e) => e.tagName), ['H2', 'UL']);
    for (let i = 0; i < 12; i++) p.press('Backspace');    // second bullet and its break
    assert.deepEqual(p.blocks(), [h2, { type: 'li', text: 'first item' }]);
    assert.equal(p.d.querySelectorAll('#cover > ul').length, 1, 'the list stays while it has an item');
    for (let i = 0; i < 11; i++) p.press('Backspace');    // first bullet and its break
    assert.deepEqual(p.blocks(), [h2]);
    assert.equal(p.d.querySelectorAll('#cover > ul').length, 0, 'an emptied list is removed');
    assert.equal(await p.readReal(), '123456', '37 keystrokes minus 31 backspaces');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('picking another look on the intro switches the cover in place and keeps the real text', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('abc');
    p.$('#btn-help').click();
    assert.equal(p.$('input[name="mode"][value="book"]').checked, true);
    assert.equal(p.$('input[name="mode"][value="work"]').disabled, false, 'the work document can be picked');
    p.$('input[name="mode"][value="work"]').checked = true;
    p.start();
    await p.settle();
    assert.deepEqual(p.loads, ['book', 'work'], 'the page asked the loader for the work cover');
    assert.equal(p.w.PlainSight.coverId(), 'work');
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'work');
    assert.equal(p.d.title, 'Q3 planning notes');
    assert.ok(p.d.body.classList.contains('cover-work'));
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 3), 'the screen is rebuilt for the three keystrokes');
    assert.equal(await p.readReal(), 'abc');
    p.$('#btn-help').click();
    assert.equal(p.$('input[name="mode"][value="work"]').checked, true, 'the intro shows the current cover');
    p.$('input[name="mode"][value="book"]').checked = true;
    p.start();
    await p.settle();
    assert.deepEqual(p.loads, ['book', 'work', 'book']);
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.equal(p.d.title, 'Untitled draft');
    assert.equal(await p.readReal(), 'abc');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('covers/work.js: a sans work document of at least 1,200 words with headings, bullets, owners and a decisions section', async () => {
  const c = await importCover('work');
  assert.equal(c.id, 'work');
  assert.equal(c.font, 'sans');
  assert.equal(c.tabTitle, 'Q3 planning notes');
  assert.equal(c.header.left, 'Q3 planning notes');
  assert.deepEqual(c.header.right, ['last edited']);
  const words = (c.text.replace(/^(## |- )/gm, '').match(/\S+/g) || []).length;
  assert.ok(words >= 1200, 'at least 1,200 words, got ' + words);
  assert.ok((c.text.match(/^## /gm) || []).length >= 4, 'short headings');
  assert.ok((c.text.match(/^- /gm) || []).length >= 10, 'bullet lists');
  assert.match(c.text, /^## Decisions$/m, 'a decisions section');
  assert.match(c.text, /^## Action items$/m);
  assert.ok((c.text.match(/Owner: /g) || []).length >= 5, 'action items carry owners');
  const src = readFileSync(path.join(ROOT, 'covers', 'work.js'), 'utf8');
  assert.match(src, /fictional/i, 'the file says its company and people are fictional');
});

test('switching to paper loads that cover: the title block renders, "Page 1 of 1" is static, academic serif, no toolbar', async () => {
  const p = await loadPage({ storage: { 'plainSight.cover': 'paper', 'plainSight.introSeen': '1' } });
  try {
    const c = await importCover('paper');
    assert.equal(p.w.PlainSight.coverId(), 'paper');
    assert.equal(p.d.title, 'Manuscript draft');
    assert.equal(p.$('#header-left').textContent, 'Manuscript draft');
    assert.ok(p.d.body.classList.contains('font-academic') && p.d.body.classList.contains('cover-paper'));
    assert.ok(!p.d.body.classList.contains('cover-work'), 'the toolbar class is not on the body');
    assert.equal(p.$('#title-block').hidden, false, 'title block shown');
    assert.equal(p.$('#paper-title').textContent, c.titleBlock.title);
    assert.equal(p.$('#paper-authors').textContent, c.titleBlock.authors);
    assert.equal(p.$('#paper-affiliation').textContent, c.titleBlock.affiliation);
    assert.equal(p.$('#page-count').textContent, 'Page 1 of 1');
    assert.equal(p.$('#word-count'), null);
    assert.equal(p.$('#last-edited'), null);
    const typed = 'Typing on the manuscript, a sentence long enough to pass the abstract heading.';
    p.type(typed);
    assert.equal(p.$('#page-count').textContent, 'Page 1 of 1', 'static');
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), typed.length));
    assert.equal(p.blocks()[0].type, 'h2', 'the paper opens with the Abstract heading');
    assert.equal(await p.readReal(), typed);
    // Back to the novel: the title block goes away.
    p.$('#btn-help').click();
    p.$('input[name="mode"][value="book"]').checked = true;
    p.start();
    await p.settle();
    assert.equal(p.w.PlainSight.coverId(), 'book');
    assert.equal(p.$('#title-block').hidden, true, 'title block hidden for the novel');
    assert.equal(p.$('#page-count'), null);
    assert.equal(await p.readReal(), typed);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('[1] style citations pass through as plain text; reference entries are typed as text and styled as references', async () => {
  const custom = 'See [1] and [2] for details.\n\n## References\n[1] First reference.\n[2] Second reference.';
  const p = await loadPage({ storage: { 'plainSight.cover': 'paper', 'plainSight.introSeen': '1', 'plainSight.customText': custom } });
  try {
    assert.equal(p.w.PlainSight.coverText(), 'See [1] and [2] for details.\n## References\n[1] First reference.\n[2] Second reference.');
    p.type('a'.repeat(28));
    assert.deepEqual(p.blocks(), [{ type: 'p', text: 'See [1] and [2] for details.' }]);
    assert.equal(p.$('#cover').querySelectorAll('a, sup').length, 0, 'citations are plain text, not links or superscripts');
    p.type('a'.repeat(1 + 10));                 // break, "References"
    assert.deepEqual(p.blocks()[1], { type: 'h2', text: 'References' });
    p.type('a'.repeat(1 + 20));                 // break, "[1] First reference."
    assert.deepEqual(p.blocks()[2], { type: 'ref', text: '[1] First reference.' }, 'the [1] prefix is typed like any text');
    assert.equal(p.$('#cover > p.ref').textContent, '[1] First reference.');
    p.type('a'.repeat(1 + 4));                  // break, "[2] "
    assert.deepEqual(p.blocks()[3], { type: 'ref', text: '[2] ' });
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.PlainSight.coverText(), 28 + 11 + 21 + 5), 'reference model agrees');
    for (let i = 0; i < 5; i++) p.press('Backspace');
    assert.equal(p.blocks().length, 3);
    assert.equal(await p.readReal(), 'a'.repeat(28 + 11 + 21));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('covers/paper.js: academic paper of at least 1,500 words with the required sections, [n] citations and fictional references', async () => {
  const c = await importCover('paper');
  assert.equal(c.id, 'paper');
  assert.equal(c.font, 'academic');
  assert.equal(c.tabTitle, 'Manuscript draft');
  assert.deepEqual(c.header.right, ['page x of y']);
  assert.ok(c.titleBlock && c.titleBlock.title.length > 20 && c.titleBlock.authors && c.titleBlock.affiliation, 'title block present');
  const body = c.text.replace(/^## .*$/gm, '').replace(/^\[\d+\] /gm, '');
  const words = (body.match(/\S+/g) || []).length;
  assert.ok(words >= 1500, 'at least 1,500 words, got ' + words);
  for (const h of ['## Abstract', '## 1. Introduction', '## 2. Method', '## 3. Results', '## 4. Discussion', '## References']) {
    assert.ok(new RegExp('^' + h.replace('.', '\\.') + '$', 'm').test(c.text), 'section present: ' + h);
  }
  assert.ok((c.text.match(/ \[\d\]/g) || []).length >= 6, 'in-text [n] citations');
  const refs = c.text.match(/^\[\d+\] .+$/gm) || [];
  assert.ok(refs.length >= 5, 'reference entries');
  const cited = new Set((c.text.match(/\[(\d+)\]/g) || []).map((m) => m.slice(1, -1)));
  for (const r of refs) assert.ok(cited.has(r.match(/^\[(\d+)\]/)[1]), 'every reference is cited: ' + r.slice(0, 12));
  const src = readFileSync(path.join(ROOT, 'covers', 'paper.js'), 'utf8');
  assert.match(src, /citations are fictional/i, 'the file states that all citations are fictional');
  assert.match(src, /PLACEHOLDER/, 'author and affiliation are marked as placeholders in the code');
});

test('localStorage never holds the hidden text: only the three known keys, and no value contains what was typed', async () => {
  const p = await loadPage();
  try {
    p.start();
    const secret = 'zq7 secret phrase 991';
    p.type(secret);
    const allowed = ['plainSight.introSeen', 'plainSight.cover', 'plainSight.customText'];
    const check = (label) => {
      const ls = p.w.localStorage;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        const v = ls.getItem(k);
        assert.ok(allowed.includes(k), label + ': unexpected key ' + k + ' (the vault is off in this test)');
        assert.ok(!v.includes('secret phrase') && !v.includes('zq7'), label + ': ' + k + ' holds typed text');
      }
    };
    check('after typing');
    p.$('#btn-save').click();
    await p.submitPassword('pw');
    await p.settle(400);
    check('after save');
    chooseFile(p, makeCoverFile(p.w, await p.downloads[0].blob.text()));
    await p.settle();
    await p.submitPassword('pw');
    await p.settle(400);
    check('after open');
    p.$('#btn-help').click();
    p.$('#custom-text').value = 'my own cover words';
    p.start();
    check('after custom text');
    assert.equal(p.w.localStorage.getItem('plainSight.customText'), 'my own cover words');
    await p.peek();
    p.peekChord();
    check('after peek');
    await sleep(VAULT_SAVE_DELAY_MS + 300);
    check('after the autosave delay, with the vault off');
    assert.equal(await p.readReal(), secret);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('opening a dialog ends an active peek, so the real text is never under the Save prompt or the intro', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('under the dialog');
    await p.peek();
    assert.equal(p.peeking(), true);
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false);
    assert.equal(p.peeking(), false, 'opening the password dialog ends the peek');
    assert.equal(p.$('#real').textContent, '');
    assert.equal(p.press('G', { ctrlKey: true, shiftKey: true }), false, 'the chord does nothing while a dialog is open');
    assert.equal(p.peeking(), false);
    p.press('Escape');
    assert.equal(p.$('#pw').hidden, true);
    await p.peek();
    assert.equal(p.peeking(), true);
    p.$('#btn-help').click();
    assert.equal(p.peeking(), false, 'opening the intro ends an active peek');
    assert.equal(p.$('#real').textContent, '');
    p.press('Escape');   // closes the intro
    assert.equal(p.$('#intro').hidden, true);
    assert.equal(await p.readReal(), 'under the dialog');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
test('a cover switch whose import fails keeps the current cover, shows a toast and forgets the failed choice', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('abc');
    p.failCovers.add('work');
    p.$('#btn-help').click();
    p.$('input[name="mode"][value="work"]').checked = true;
    p.start();
    await p.settle();
    assert.deepEqual(p.loads, ['book', 'work']);
    assert.equal(p.w.PlainSight.coverId(), 'book', 'the novel stays on screen');
    assert.equal(p.$('#load-notice').hidden, true, 'no notice while a cover is on screen');
    assert.equal(p.toast(), 'Could not load the cover text');
    assert.equal(p.w.localStorage.getItem('plainSight.cover'), 'book', 'the failed choice is not remembered');
    assert.equal(await p.readReal(), 'abc');
    assert.deepEqual(p.errors, []);
    // With nothing on screen the stored id is dropped and the notice is shown.
    const q = await loadPage({ inject: false, storage: { 'plainSight.cover': 'paper', 'plainSight.introSeen': '1' } });
    try {
      q.w.PlainSight.coverFailed('paper');
      assert.equal(q.w.localStorage.getItem('plainSight.cover'), null);
      assert.equal(q.$('#load-notice').hidden, false);
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
  } finally { p.close(); }
});

test('device vault: on with a phrase, ciphertext only in localStorage, autosave, the tell, Esc locks and keeps the copy', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('first words');
    await p.vaultOn('correct horse battery staple');
    assert.equal(p.$('#intro').hidden, true, 'Start closed the intro');
    assert.ok(p.d.body.classList.contains('vault-open'), 'the vault is open');
    let dump = p.storageDump();
    assert.ok(dump['plainSight.vault'], 'a vault record exists');
    let rec = JSON.parse(dump['plainSight.vault']);
    assert.equal(rec.format, 'plain-sight');
    assert.equal(Buffer.from(rec.salt, 'base64').length, 16);
    assert.equal(Buffer.from(rec.iv, 'base64').length, 12);
    assert.equal(Buffer.from(rec.data, 'base64').length, 'first words'.length + 16, 'ciphertext of the current text');
    for (const v of Object.values(dump)) assert.ok(!v.includes('first words') && !v.includes('correct horse'), 'neither the text nor the phrase is stored in clear');
    // Autosave after typing.
    p.type(' and more');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const rec2 = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(Buffer.from(rec2.data, 'base64').length, 'first words and more'.length + 16, 'autosave caught the new text');
    assert.notEqual(rec2.iv, rec.iv, 'a fresh IV every save');
    assert.equal(rec2.salt, rec.salt, 'the salt stays with the phrase');
    // Esc saves the words typed since the last autosave, wipes the screen,
    // locks the vault and keeps the copy.
    p.type(' typed just before Esc');
    p.press('Escape');
    assert.equal(p.coverText(), '');
    assert.equal(await p.readReal(), '');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    await sleep(500);
    const rec3 = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.notEqual(rec3.iv, rec2.iv, 'Esc wrote a fresh save');
    assert.equal(await decryptVault(rec3, 'correct horse battery staple'), 'first words and more typed just before Esc', 'the copy holds everything typed up to Esc');
    // While locked, typing is not saved anywhere and no timer fires later.
    p.type('typed while locked');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(JSON.parse(p.storageDump()['plainSight.vault']).iv, rec3.iv, 'nothing written while locked');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: the unlock chord restores the saved text on a later visit; a wrong phrase does nothing; untick deletes the copy', async () => {
  const p = await loadPage();
  let storage;
  try {
    p.start();
    p.type('kept between visits');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    storage = p.storageDump();
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }

  // A later visit: same browser storage, fresh page, vault locked.
  const q = await loadPage({ storage });
  try {
    assert.equal(q.$('#intro').hidden, true);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'locked on arrival');
    assert.equal(q.coverText(), '', 'nothing on screen');
    // Wrong phrase: the chord does nothing and the typed phrase stays.
    q.type('wrong phrase typed here');
    let r = q.unlockChord();
    assert.equal(r.armed, true, 'Ctrl+E is handled while a vault exists');
    assert.equal(r.fired, true, 'Ctrl+Enter completes the chord');
    await sleep(500);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'still locked');
    assert.equal(await q.readReal(), 'wrong phrase typed here', 'nothing changed');
    q.press('Escape');
    // Right phrase.
    q.type('correct horse battery staple');
    q.unlockChord();
    await sleep(500);
    assert.ok(q.d.body.classList.contains('vault-open'), 'open');
    assert.equal(await q.readReal(), 'kept between visits', 'the saved text replaced the phrase');
    assert.equal(q.coverLength(), 'kept between visits'.length, 'the cover was rebuilt to the saved length');
    for (const v of Object.values(q.storageDump())) assert.ok(!v.includes('kept between') && !v.includes('correct horse'));
    // The chord does nothing while the vault is already open.
    q.type(' plus');
    q.unlockChord();
    await sleep(300);
    assert.equal(await q.readReal(), 'kept between visits plus');
    // Enter outside the window does not fire.
    q.press('Escape');
    q.type('correct horse battery staple');
    q.press('e', { ctrlKey: true });
    const realNow = q.w.Date.now();
    q.w.Date.now = () => realNow + UNLOCK_WINDOW_MS + 1000;
    assert.equal(q.press('Enter', { ctrlKey: true }), false, 'a late Enter is the browser\'s');
    await sleep(300);
    assert.ok(!q.d.body.classList.contains('vault-open'));
    q.w.Date.now = () => realNow;
    // Untick in the intro: the copy is deleted.
    q.$('#btn-help').click();
    assert.equal(q.$('#vault-on').checked, true, 'the intro shows the vault as on');
    q.$('#vault-on').checked = false;
    q.$('#vault-on').dispatchEvent(new q.w.Event('change', { bubbles: true }));
    q.start();
    assert.equal(q.storageDump()['plainSight.vault'], undefined, 'copy deleted');
    assert.equal(q.toast(), 'Saved copy deleted from this device');
    assert.equal(q.press('e', { ctrlKey: true }), false, 'Ctrl+E is the browser\'s again');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a short or missing phrase is refused and the intro stays open; the box can be left unticked', async () => {
  const p = await loadPage();
  try {
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    assert.equal(p.$('#vault-phrase').disabled, false);
    p.start();
    assert.equal(p.$('#intro').hidden, false, 'no phrase: stays open');
    assert.equal(p.toast(), 'Enter a phrase to keep your text on this device');
    p.$('#vault-phrase').value = 'short one';
    p.start();
    assert.equal(p.$('#intro').hidden, false, 'short phrase: stays open');
    assert.equal(p.toast(), 'Use a phrase of at least 12 characters');
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    p.$('#vault-on').checked = false;
    p.start();
    assert.equal(p.$('#intro').hidden, true, 'unticked: closes without a vault');
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    assert.ok(!p.d.body.classList.contains('vault-open'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: a phrase entered while the copy is locked opens it (text typed before follows), a wrong one is refused, and Esc on the intro applies the choices like Start', async () => {
  const p = await loadPage();
  let storage;
  try {
    p.start();
    p.type('saved earlier');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    storage = p.storageDump();
  } finally { p.close(); }
  const q = await loadPage({ storage });
  try {
    q.type('new words');
    q.$('#btn-help').click();
    assert.equal(q.$('#vault-on').checked, true);
    // Wrong phrase: refused, nothing overwritten, intro stays open.
    q.$('#vault-phrase').value = 'definitely not the phrase';
    q.start();
    await sleep(500);
    assert.equal(q.$('#intro').hidden, false, 'intro stays open');
    assert.equal(q.toast(), 'That phrase does not open the saved copy. Untick the box to delete it and start over.');
    assert.equal(await decryptVault(JSON.parse(q.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'saved earlier', 'the copy is untouched');
    assert.ok(!q.d.body.classList.contains('vault-open'));
    // Right phrase, applied with Esc instead of Start: the copy opens and the new words follow it.
    q.$('#vault-phrase').value = 'correct horse battery staple';
    q.press('Escape');
    await sleep(600);
    assert.equal(q.$('#intro').hidden, true, 'Esc applied the choice and closed the intro');
    assert.ok(q.d.body.classList.contains('vault-open'), 'open');
    assert.equal(q.toast(), 'Saved copy opened');
    assert.equal(await q.readReal(), 'saved earliernew words');
    // A new phrase while open re-keys the copy; the old phrase stops working.
    q.$('#btn-help').click();
    q.$('#vault-phrase').value = 'a brand new phrase here';
    q.start();
    await sleep(600);
    const rec = JSON.parse(q.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(rec, 'a brand new phrase here'), 'saved earliernew words');
    await assert.rejects(decryptVault(rec, 'correct horse battery staple'), 'the old phrase no longer opens it');
    // Esc on the intro with the box unticked deletes the copy, like Start would.
    q.$('#btn-help').click();
    q.$('#vault-on').checked = false;
    q.press('Escape');
    await sleep(100);
    assert.equal(q.storageDump()['plainSight.vault'], undefined, 'deleted');
    assert.ok(!q.d.body.classList.contains('vault-open'));
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: an unreadable record can be deleted from the intro, and Ctrl+E is left to the browser while the record is unreadable', async () => {
  const p = await loadPage({ storage: { 'plainSight.vault': '{not json', 'plainSight.introSeen': '1' } });
  try {
    assert.equal(p.press('e', { ctrlKey: true }), false, 'an unreadable record does not arm the chord');
    p.$('#btn-help').click();
    assert.equal(p.$('#vault-on').checked, false, 'unreadable: shown as off');
    p.$('#vault-on').checked = false;
    p.start();
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'the orphan record is removed');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('device vault: Esc cancels an unlock in flight; keys typed during the derivation are kept after the saved text; another chord resets the armed state', async () => {
  const p = await loadPage();
  let storage;
  try {
    p.start();
    p.type('saved text');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    storage = p.storageDump();
  } finally { p.close(); }
  const q = await loadPage({ storage });
  try {
    // Esc right after the chord: the unlock never lands.
    q.type('correct horse battery staple');
    q.unlockChord();
    q.press('Escape');
    await sleep(700);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'cancelled');
    assert.equal(await q.readReal(), '', 'buffer stays empty');
    // Keys typed while the key derives are kept after the saved text.
    q.type('correct horse battery staple');
    q.unlockChord();
    q.type('ab');
    await sleep(700);
    assert.ok(q.d.body.classList.contains('vault-open'));
    assert.equal(await q.readReal(), 'saved textab');
    q.press('Escape');
    await sleep(300);
    // Ctrl+E, then another chord, then Ctrl+Enter: not an unlock.
    q.type('correct horse battery staple');
    assert.equal(q.press('e', { ctrlKey: true }), true);
    assert.equal(q.press('b', { ctrlKey: true }), false, 'another chord goes to the browser');
    assert.equal(q.press('Enter', { ctrlKey: true }), false, 'and the armed state is gone');
    await sleep(400);
    assert.ok(!q.d.body.classList.contains('vault-open'), 'not unlocked');
    assert.deepEqual(q.errors, []);
  } finally { q.close(); }
});

test('device vault: a page hide saves the latest words; nothing is written after a lock', async () => {
  const p = await loadPage();
  try {
    p.start();
    await p.vaultOn('correct horse battery staple');
    p.type('typed then hidden');
    p.w.dispatchEvent(new p.w.Event('pagehide'));
    await sleep(500);
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'typed then hidden');
    p.type(' and more');
    p.press('Escape');
    await sleep(500);
    const afterEsc = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(afterEsc, 'correct horse battery staple'), 'typed then hidden and more');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(JSON.parse(p.storageDump()['plainSight.vault']).iv, afterEsc.iv, 'no write after the lock');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('storage keys from the 1.0 name are moved to the new ones once, and the old ones removed', async () => {
  const p = await loadPage({ storage: { 'coverStory.introSeen': '1', 'coverStory.cover': 'work', 'coverStory.customText': 'my own words here' } });
  try {
    assert.equal(p.$('#intro').hidden, true, 'a returning visitor does not see the intro again');
    assert.equal(p.w.PlainSight.coverId(), 'work', 'the cover choice carries over');
    assert.equal(p.w.PlainSight.coverText(), 'my own words here', 'custom text carries over');
    const dump = p.storageDump();
    assert.deepEqual(Object.keys(dump).sort(), ['plainSight.cover', 'plainSight.customText', 'plainSight.introSeen']);
    assert.equal(dump['plainSight.cover'], 'work');
    // Existing new keys win over old ones.
    const q = await loadPage({ storage: { 'coverStory.cover': 'work', 'plainSight.cover': 'paper', 'plainSight.introSeen': '1' } });
    try {
      assert.equal(q.w.PlainSight.coverId(), 'paper');
      assert.equal(q.storageDump()['coverStory.cover'], undefined, 'old key removed');
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: Save writes a plain text file named by the moment into the chosen folder, no password; forgetting the folder brings the download back', async () => {
  const folder = fakeFolder('Notes');
  const p = await loadPage({ folder });
  try {
    assert.equal(p.$('#btn-folder').hidden, false, 'the picker is offered');
    assert.equal(p.$('#btn-folder-forget').hidden, true);
    assert.match(p.$('#folder-status').textContent, /downloads an encrypted/);
    p.$('#btn-folder').click();
    await p.settle();
    assert.equal(p.$('#folder-status').textContent, 'Save writes a plain text file into the folder "Notes".');
    assert.equal(p.$('#btn-folder-forget').hidden, false);
    assert.equal(p.toast(), 'Save now writes into Notes');
    p.start();
    p.type('plain words for the folder');
    p.$('#btn-save').click();
    await p.settle(200);
    assert.equal(p.$('#pw').hidden, true, 'no password dialog');
    assert.equal(folder.written.length, 1, 'one file written');
    assert.match(folder.written[0].name, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.txt$/);
    assert.equal(folder.written[0].text, 'plain words for the folder');
    assert.equal(folder.written[0].create, true);
    assert.equal(p.downloads.length, 0, 'no download');
    assert.equal(p.toast(), 'Saved ' + folder.written[0].name + ' in Notes');
    assert.equal(await p.readReal(), 'plain words for the folder', 'saving keeps the text');
    // Forget the folder: Save downloads an encrypted file again.
    p.$('#btn-help').click();
    p.$('#btn-folder-forget').click();
    await p.settle();
    assert.equal(p.toast(), 'Save downloads an encrypted file again');
    assert.equal(p.$('#btn-folder-forget').hidden, true);
    p.start();
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false, 'password dialog is back');
    await p.submitPassword('pw-1');
    await p.settle(400);
    assert.equal(p.downloads.length, 1);
    assert.equal(folder.written.length, 1, 'nothing more written to the folder');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: a cancelled picker changes nothing; a refused permission or a failed write shows a toast and keeps the text', async () => {
  const folder = fakeFolder('Blocked', { permission: 'denied' });
  const p = await loadPage({ folder });
  try {
    folder.cancel = true;
    p.$('#btn-folder').click();
    await p.settle();
    assert.match(p.$('#folder-status').textContent, /downloads an encrypted/, 'cancel leaves the download');
    folder.cancel = false;
    p.$('#btn-folder').click();
    await p.settle();
    p.start();
    p.type('kept');
    p.$('#btn-save').click();
    await p.settle(200);
    assert.equal(p.toast(), 'No permission for the folder. Choose it again under the ? button.');
    assert.equal(folder.written.length, 0);
    assert.equal(await p.readReal(), 'kept');
    // A write that throws.
    folder.handle.queryPermission = async () => 'granted';
    folder.handle.getFileHandle = async () => { throw new Error('disk gone'); };
    p.$('#btn-save').click();
    await p.settle(200);
    assert.equal(p.toast(), 'Could not write to the folder');
    assert.equal(await p.readReal(), 'kept');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('save folder: without the folder API the picker is hidden and Save downloads', async () => {
  const p = await loadPage();
  try {
    assert.equal(typeof p.w.showDirectoryPicker, 'undefined');
    assert.equal(p.$('#btn-folder').hidden, true);
    assert.match(p.$('#folder-status').textContent, /does not offer folder access/);
    p.start();
    p.type('abc');
    p.$('#btn-save').click();
    assert.equal(p.$('#pw').hidden, false);
    p.press('Escape');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Esc during a vault setup or phrase change sticks: no vault appears afterwards, and a phrase change in flight leaves the old copy intact', async () => {
  const p = await loadPage();
  try {
    // New vault: Esc right after Start, before the key is derived.
    p.start();
    p.type('setup words');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = true;
    p.$('#vault-on').dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.$('#vault-phrase').value = 'correct horse battery staple';
    p.start();
    p.press('Escape');
    await sleep(700);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'the vault did not reopen after Esc');
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'no copy was written after Esc');
    assert.equal(await p.readReal(), '');
    // Phrase change on an open vault: Esc right after Start keeps the old copy under the old phrase.
    p.type('keep this text');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    p.$('#btn-help').click();
    p.$('#vault-phrase').value = 'a different phrase entirely';
    p.start();
    p.press('Escape');
    await sleep(700);
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked');
    const rec = JSON.parse(p.storageDump()['plainSight.vault']);
    assert.equal(await decryptVault(rec, 'correct horse battery staple'), 'keep this text', 'the old copy survives under the old phrase');
    await assert.rejects(decryptVault(rec, 'a different phrase entirely'));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Esc during Save still saves the text that was on the page; Esc during Open cancels it and the buffer stays empty', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('words to save');
    p.$('#btn-save').click();
    await p.submitPassword('pw-1');
    p.press('Escape');   // while the key derives
    await sleep(600);
    assert.equal(p.downloads.length, 1);
    assert.equal(p.toast(), 'Saved');
    const f = JSON.parse(await p.downloads[0].blob.text());
    assert.equal(Buffer.from(f.data, 'base64').length, 'words to save'.length + 16, 'the file holds the text, not nothing');
    assert.equal(await p.readReal(), '', 'and the page was wiped');
    // Open, then Esc while the key derives: nothing comes back.
    chooseFile(p, makeCoverFile(p.w, JSON.stringify(f)));
    await p.settle();
    await p.submitPassword('pw-1');
    p.press('Escape');
    await sleep(600);
    assert.equal(p.toast(), 'Open cancelled');
    assert.equal(await p.readReal(), '', 'the file text did not land after Esc');
    assert.equal(p.coverText(), '');
    // Without the Esc the same file opens.
    chooseFile(p, makeCoverFile(p.w, JSON.stringify(f)));
    await p.settle();
    await p.submitPassword('pw-1');
    await sleep(600);
    assert.equal(await p.readReal(), 'words to save');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('another tab deleting or re-keying the copy locks this tab, which never writes the old copy back', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('shared copy');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const original = p.storageDump()['plainSight.vault'];
    // Another tab unticks: the record disappears and a storage event arrives.
    p.w.localStorage.removeItem('plainSight.vault');
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: original, newValue: null }));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'this tab locked');
    assert.equal(p.toast(), 'The saved copy changed in another tab; this tab is locked');
    p.type(' more');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(p.storageDump()['plainSight.vault'], undefined, 'nothing written back');
    // Re-keyed in another tab: a record with a different salt.
    p.press('Escape');
    p.type('second round');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const mine = JSON.parse(p.storageDump()['plainSight.vault']);
    const theirs = JSON.stringify({ ...mine, salt: Buffer.from(new Uint8Array(16).fill(7)).toString('base64') });
    p.w.localStorage.setItem('plainSight.vault', theirs);
    p.w.dispatchEvent(new p.w.StorageEvent('storage', { key: 'plainSight.vault', oldValue: JSON.stringify(mine), newValue: theirs }));
    assert.ok(!p.d.body.classList.contains('vault-open'), 'locked on a re-key');
    p.type(' x');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(p.storageDump()['plainSight.vault'], theirs, 'the other tab\'s copy stands');
    // The write path checks the salt too, in case the event is late. First drop
    // the foreign copy (untick), then start a fresh vault of our own.
    p.press('Escape');
    p.$('#btn-help').click();
    p.$('#vault-on').checked = false;
    p.start();
    assert.equal(p.storageDump()['plainSight.vault'], undefined);
    p.type('third');
    await p.vaultOn('correct horse battery staple');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    const mine3 = p.storageDump()['plainSight.vault'];
    p.w.localStorage.setItem('plainSight.vault', theirs);   // changed underneath, no event
    p.type(' typed');
    await sleep(VAULT_SAVE_DELAY_MS + 400);
    assert.equal(p.storageDump()['plainSight.vault'], theirs, 'a stale key never overwrites another tab\'s copy');
    assert.ok(!p.d.body.classList.contains('vault-open'), 'and the tab locks');
    assert.notEqual(mine3, theirs);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('leaving the page saves an open vault (beforeunload as well as pagehide)', async () => {
  const p = await loadPage();
  try {
    p.start();
    await p.vaultOn('correct horse battery staple');
    p.type('typed then leaving');
    p.w.dispatchEvent(new p.w.Event('beforeunload', { cancelable: true }));
    await sleep(500);
    assert.equal(await decryptVault(JSON.parse(p.storageDump()['plainSight.vault']), 'correct horse battery staple'), 'typed then leaving');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
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
