// Smoke test for Cover Story. Runs the real index.html in jsdom and drives it
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
const PEEK_HOLD_MS = 900;
const TEN_MINUTES = 10 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Page harness
// ---------------------------------------------------------------------------
// jsdom does not execute <script type="module">, so the harness plays the part
// of the page's cover loader: it imports covers/<id>.js in node (which also
// proves the file is a valid ES module) and hands the object to
// CoverStory.setCover(), exactly as the bridge script does, and it answers the
// same coverstory:select event when the page asks for another cover.
async function importCover(id) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'covers', id + '.js')).href);
  return mod.default;
}

async function loadPage({ random = () => 1, storage = {}, inject = true } = {}) {
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
    }
  });

  const w = dom.window;
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);

  const loads = [];
  const failCovers = new Set();   // ids whose load the harness should fail on purpose
  async function loadCover(id) {
    loads.push(id);
    if (failCovers.has(id)) { w.CoverStory.coverFailed(id); return; }
    try { w.CoverStory.setCover(await importCover(id)); } catch (err) { w.CoverStory.coverFailed(id); }
  }
  d.addEventListener('coverstory:select', (e) => { loadCover(e.detail.id); });
  if (inject) {
    await loadCover(w.CoverStory.selectedCoverId());
    await w.CoverStory.ready;
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
    // Hold Ctrl past the threshold and read the real text off the screen.
    // Leaves Ctrl held; call release('Control') afterwards.
    async peek() {
      page.press('Control', { ctrlKey: true });
      await sleep(PEEK_HOLD_MS + 150);
      return $('#real').textContent;
    },
    async readReal() {
      const text = await page.peek();
      page.release('Control');
      return text;
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
function makeCoverFile(w, json) {
  return new w.File([json], 'test.cover', { type: 'application/json' });
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
    assert.equal(p.w.localStorage.getItem('coverStory.introSeen'), null);
    p.start();
    assert.equal(p.$('#intro').hidden, true, 'intro hidden after Start');
    assert.equal(p.w.localStorage.getItem('coverStory.introSeen'), '1');
    assert.equal(p.d.title, 'Untitled draft');
    assert.ok(p.d.body.classList.contains('font-serif'));
    assert.equal(p.$('#header-left').textContent, 'Untitled draft');
    assert.equal(p.wordCount(), '0 words');
    assert.equal(p.coverText(), '');
    assert.deepEqual(p.blocks(), [{ type: 'h2', text: '' }], 'the story opens with a chapter heading block');
    assert.equal(p.w.CoverStory.coverId(), 'book', 'the cover loaded is book');
    assert.deepEqual(p.loads, ['book'], 'exactly one cover load was requested');
    assert.equal(p.w.localStorage.getItem('coverStory.cover'), 'book', 'the selection persists');
    assert.equal(p.$('#load-notice').hidden, true);
    assert.ok(p.w.CoverStory.coverText().length > 1500, 'cover text present');
    assert.equal(p.$('#cover').querySelector('.caret').textContent, '', 'caret adds no text');
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
    const expected = expectedBlocks(p.w.CoverStory.coverText(), 40);
    assert.deepEqual(p.blocks(), expected);
    assert.equal(p.peeking(), false, 'peek class absent after typing');
    assert.equal(await p.readReal(), typed, 'real buffer equals what was typed');
    assert.equal(p.peeking(), false, 'peek ends on keyup');
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
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), 7));
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
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), 2));
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

test('Ctrl held past 900ms adds peek; keyup removes it; window blur removes it; a short tap does not peek', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('hidden text');
    p.press('Control', { ctrlKey: true });
    await sleep(600);
    assert.equal(p.peeking(), false, 'not yet peeking at 600ms');
    await sleep(450);
    assert.equal(p.peeking(), true, 'peeking after 900ms');
    assert.equal(p.$('#real').textContent, 'hidden text');
    p.release('Control');
    assert.equal(p.peeking(), false, 'keyup ends peek');
    assert.equal(p.$('#real').textContent, '');
    // Short tap: no peek.
    p.press('Control', { ctrlKey: true });
    await sleep(200);
    p.release('Control');
    await sleep(PEEK_HOLD_MS);
    assert.equal(p.peeking(), false, 'a short tap never peeks');
    // Blur while peeking (for example Cmd+Tab away) ends the peek.
    p.press('Meta', { metaKey: true });
    await sleep(PEEK_HOLD_MS + 150);
    assert.equal(p.peeking(), true, 'Cmd peeks too');
    p.w.dispatchEvent(new p.w.Event('blur'));
    assert.equal(p.peeking(), false, 'blur ends peek');
    // Repeated keydown events for a held Control (Windows) must not restart the timer.
    p.press('Control', { ctrlKey: true });
    for (let i = 0; i < 8; i++) { await sleep(100); p.press('Control', { ctrlKey: true, repeat: true }); }
    await sleep(250);
    assert.equal(p.peeking(), true, 'auto-repeat does not reset the hold');
    p.release('Control');
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
    p.release('Control');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('simulated typo: a wrong neighbouring letter appears at a word start and the next keystroke removes it', async () => {
  const p = await loadPage({ random: () => 0 });   // 0 < 3.5 percent: typo on every word start
  try {
    p.start();
    const text = p.w.CoverStory.coverText();
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
  const p = await loadPage({ storage: { 'coverStory.customText': 'ab cd', 'coverStory.introSeen': '1' } });
  try {
    assert.equal(p.$('#intro').hidden, true, 'intro not shown on a return visit');
    assert.equal(p.w.CoverStory.coverText(), 'ab cd');
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
  const p = await loadPage({ storage: { 'coverStory.customText': '## Title\n\nBody text', 'coverStory.introSeen': '1' } });
  try {
    assert.equal(p.w.CoverStory.coverText(), '## Title\nBody text');
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
    const expected = countWords(expectedBlocks(p.w.CoverStory.coverText(), 20));
    assert.ok(expected > 1, 'the first 20 cover characters hold more than one word');
    assert.equal(p.wordCount(), expected + ' words');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Save writes a .cover with a 16-byte salt, 12-byte IV and data; Open restores it with the right password and refuses wrong passwords, damaged files, foreign formats and bad iteration counts with a toast', async () => {
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
    assert.equal(f.format, 'cover-story');
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
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), 11));

    // Damaged, foreign or hostile files are refused, most of them before any key derivation.
    const variant = (changes) => JSON.stringify({ ...f, ...changes });
    assert.equal(await open('{"salt":1}', 'x'), 'That is not a .cover file');
    assert.equal(await open('not json', 'x'), 'That is not a .cover file');
    assert.equal(await open(variant({ iterations: 50000000 }), 'correct horse'), 'Wrong password or damaged file', 'iteration cap');
    assert.equal(await open(variant({ iterations: 999 }), 'correct horse'), 'Wrong password or damaged file', 'iteration floor');
    assert.equal(await open(variant({ iterations: '310000' }), 'correct horse'), 'That is not a .cover file', 'iterations must be a number');
    assert.equal(await open(variant({ iv: f.salt }), 'correct horse'), 'Wrong password or damaged file', 'IV length');
    assert.equal(await open(variant({ format: 'other' }), 'correct horse'), 'That is not a .cover file');
    assert.equal(await open(variant({ version: 2 }), 'correct horse'), 'That is not a .cover file');
    assert.equal(await open(variant({ cipher: 'AES-128-GCM' }), 'correct horse'), 'That is not a .cover file');
    assert.equal(await open(variant({ kdf: 'scrypt' }), 'correct horse'), 'That is not a .cover file');
    const bytes = Buffer.from(f.data, 'base64');
    bytes[0] ^= 1;
    assert.equal(await open(variant({ data: bytes.toString('base64') }), 'correct horse'), 'Wrong password or damaged file', 'a flipped ciphertext bit fails authentication');
    assert.equal(await p.readReal(), 'hello world', 'every refusal left the buffer alone');
    // Nothing on the console object touches the buffer.
    assert.deepEqual(Object.keys(p.w.CoverStory).sort(), ['coverFailed', 'coverId', 'coverIds', 'coverText', 'ready', 'selectedCoverId', 'setCover', 'version']);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('Save button: password dialog, then a .cover download holding valid JSON; nothing to save shows a toast', async () => {
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
    assert.match(p.downloads[0].name, /^untitled-draft-\d{8}-\d{4}\.cover$/);
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
    assert.equal(p.toast(), 'That is not a .cover file');
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
    assert.equal(p.w.localStorage.getItem('coverStory.customText'), 'one two three four five six');
    assert.equal(p.w.CoverStory.coverText(), 'one two three four five six');
    assert.equal(p.coverText(), 'one', 'the screen is rebuilt for the 3 keystrokes already typed');
    assert.equal(await p.readReal(), 'abc');
    // Clearing the box goes back to the built-in text.
    p.$('#btn-help').click();
    p.$('#custom-text').value = '';
    p.start();
    assert.equal(p.w.localStorage.getItem('coverStory.customText'), null);
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), 3));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('intro has the three mode radios; book is checked; the selection is written on Start', async () => {
  const p = await loadPage();
  try {
    const radios = Array.from(p.d.querySelectorAll('input[name="mode"]'));
    assert.deepEqual(radios.map((r) => r.value), ['book', 'work', 'paper']);
    assert.deepEqual(radios.map((r) => r.checked), [true, false, false]);
    assert.equal(p.w.localStorage.getItem('coverStory.cover'), null, 'nothing stored before Start');
    p.start();
    assert.equal(p.w.localStorage.getItem('coverStory.cover'), 'book');
    assert.equal(p.w.CoverStory.selectedCoverId(), 'book');
    assert.deepEqual(p.loads, ['book'], 'picking the cover already on screen requests nothing');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a remembered cover id is used on the next visit; unknown ids fall back to book', async () => {
  const p = await loadPage({ storage: { 'coverStory.cover': 'nonsense', 'coverStory.introSeen': '1' } });
  try {
    assert.equal(p.w.CoverStory.selectedCoverId(), 'book');
    assert.equal(p.w.CoverStory.coverId(), 'book');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('before a cover is on screen typing is ignored and left to the browser; a failed load shows the notice; a bad cover object is refused', async () => {
  const p = await loadPage({ inject: false, storage: { 'coverStory.introSeen': '1' } });
  try {
    assert.equal(p.w.CoverStory.coverId(), null);
    assert.equal(p.press('a'), false, 'not prevented');
    assert.equal(p.press('Escape'), false);
    assert.equal(p.$('#cover').children.length, 0);
    assert.equal(p.$('#load-notice').hidden, true);
    p.w.CoverStory.coverFailed('book');
    assert.equal(p.$('#load-notice').hidden, false, 'notice shown');
    assert.equal(p.toast(), 'Could not load the cover text');
    assert.throws(() => p.w.CoverStory.setCover({ id: 'book', text: 'x' }), /Not a cover object/);
    assert.throws(() => p.w.CoverStory.setCover({ id: 'evil', label: 'x', tabTitle: 'x', font: 'serif', header: { left: 'x', right: [] }, text: 'x' }), /Not a cover object/);
    await p.loadCover('book');
    assert.equal(p.$('#load-notice').hidden, true, 'notice hidden once a cover arrives');
    assert.equal(p.w.CoverStory.coverId(), 'book');
    assert.equal(p.press('a'), true);
    assert.equal(p.coverLength(), 1);
    assert.equal(await p.readReal(), 'a');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('the module bridge imports ./covers/<id>.js for the selected id and listens for coverstory:select', () => {
  const m = HTML.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(m, 'module script present');
  const src = m[1];
  assert.ok(src.includes("import('./covers/' + id + '.js')"), 'dynamic import of the cover file');
  assert.ok(src.includes('api.setCover(mod.default)'));
  assert.ok(src.includes("addEventListener('coverstory:select'"));
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
  const p = await loadPage({ storage: { 'coverStory.cover': 'work', 'coverStory.introSeen': '1' } });
  try {
    assert.equal(p.w.CoverStory.coverId(), 'work');
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
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), typed.length));
    assert.equal(await p.readReal(), typed, 'the real buffer is unaffected by the cover');
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a cover line starting with "- " renders inside a list item; bullets share one list; headings render as headings; Backspace walks back out', async () => {
  const p = await loadPage({ storage: { 'coverStory.cover': 'work', 'coverStory.introSeen': '1', 'coverStory.customText': '## Agenda\n- first item\n- second item\n\nClosing line' } });
  try {
    assert.equal(p.w.CoverStory.coverText(), '## Agenda\n- first item\n- second item\nClosing line');
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
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), 37), 'reference model agrees');
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
    assert.equal(p.w.CoverStory.coverId(), 'work');
    assert.equal(p.w.localStorage.getItem('coverStory.cover'), 'work');
    assert.equal(p.d.title, 'Q3 planning notes');
    assert.ok(p.d.body.classList.contains('cover-work'));
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), 3), 'the screen is rebuilt for the three keystrokes');
    assert.equal(await p.readReal(), 'abc');
    p.$('#btn-help').click();
    assert.equal(p.$('input[name="mode"][value="work"]').checked, true, 'the intro shows the current cover');
    p.$('input[name="mode"][value="book"]').checked = true;
    p.start();
    await p.settle();
    assert.deepEqual(p.loads, ['book', 'work', 'book']);
    assert.equal(p.w.CoverStory.coverId(), 'book');
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
  const p = await loadPage({ storage: { 'coverStory.cover': 'paper', 'coverStory.introSeen': '1' } });
  try {
    const c = await importCover('paper');
    assert.equal(p.w.CoverStory.coverId(), 'paper');
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
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), typed.length));
    assert.equal(p.blocks()[0].type, 'h2', 'the paper opens with the Abstract heading');
    assert.equal(await p.readReal(), typed);
    // Back to the novel: the title block goes away.
    p.$('#btn-help').click();
    p.$('input[name="mode"][value="book"]').checked = true;
    p.start();
    await p.settle();
    assert.equal(p.w.CoverStory.coverId(), 'book');
    assert.equal(p.$('#title-block').hidden, true, 'title block hidden for the novel');
    assert.equal(p.$('#page-count'), null);
    assert.equal(await p.readReal(), typed);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('[1] style citations pass through as plain text; reference entries are typed as text and styled as references', async () => {
  const custom = 'See [1] and [2] for details.\n\n## References\n[1] First reference.\n[2] Second reference.';
  const p = await loadPage({ storage: { 'coverStory.cover': 'paper', 'coverStory.introSeen': '1', 'coverStory.customText': custom } });
  try {
    assert.equal(p.w.CoverStory.coverText(), 'See [1] and [2] for details.\n## References\n[1] First reference.\n[2] Second reference.');
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
    assert.deepEqual(p.blocks(), expectedBlocks(p.w.CoverStory.coverText(), 28 + 11 + 21 + 5), 'reference model agrees');
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
    const allowed = ['coverStory.introSeen', 'coverStory.cover', 'coverStory.customText'];
    const check = (label) => {
      const ls = p.w.localStorage;
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        const v = ls.getItem(k);
        assert.ok(allowed.includes(k), label + ': unexpected key ' + k);
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
    assert.equal(p.w.localStorage.getItem('coverStory.customText'), 'my own cover words');
    await p.peek();
    p.release('Control');
    check('after peek');
    assert.equal(await p.readReal(), secret);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test('a peek hold started just before a dialog opens never shows the real text under the dialog; opening the intro ends a peek', async () => {
  const p = await loadPage();
  try {
    p.start();
    p.type('under the dialog');
    p.press('Control', { ctrlKey: true });
    await sleep(200);
    p.$('#btn-save').click();   // the password dialog opens during the hold
    assert.equal(p.$('#pw').hidden, false);
    await sleep(PEEK_HOLD_MS + 300);
    assert.equal(p.peeking(), false, 'no peek while the dialog is open');
    assert.equal(p.$('#real').textContent, '', 'the real text is not in the page');
    p.release('Control');
    p.press('Escape');
    assert.equal(p.$('#pw').hidden, true);
    // An active peek (Ctrl held while Save is clicked with the mouse) ends when the dialog opens.
    await p.peek();
    assert.equal(p.peeking(), true);
    p.$('#btn-save').click();
    assert.equal(p.peeking(), false, 'opening the password dialog ends an active peek');
    assert.equal(p.$('#real').textContent, '');
    p.release('Control');
    p.press('Escape');
    assert.equal(p.$('#pw').hidden, true);
    await p.peek();
    assert.equal(p.peeking(), true);
    p.$('#btn-help').click();
    assert.equal(p.peeking(), false, 'opening the intro ends an active peek');
    assert.equal(p.$('#real').textContent, '');
    p.release('Control');
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
    assert.equal(p.w.CoverStory.coverId(), 'book', 'the novel stays on screen');
    assert.equal(p.$('#load-notice').hidden, true, 'no notice while a cover is on screen');
    assert.equal(p.toast(), 'Could not load the cover text');
    assert.equal(p.w.localStorage.getItem('coverStory.cover'), 'book', 'the failed choice is not remembered');
    assert.equal(await p.readReal(), 'abc');
    assert.deepEqual(p.errors, []);
    // With nothing on screen the stored id is dropped and the notice is shown.
    const q = await loadPage({ inject: false, storage: { 'coverStory.cover': 'paper', 'coverStory.introSeen': '1' } });
    try {
      q.w.CoverStory.coverFailed('paper');
      assert.equal(q.w.localStorage.getItem('coverStory.cover'), null);
      assert.equal(q.$('#load-notice').hidden, false);
      assert.deepEqual(q.errors, []);
    } finally { q.close(); }
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
