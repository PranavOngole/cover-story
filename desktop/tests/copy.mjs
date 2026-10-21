// Tests of desktop/copy-frontend.mjs, the allowlist that decides what the app
// bundles. Each case builds a small repository layout in a temporary folder,
// runs a copy of the script there and checks what reached desktop/frontend/.
//
// Run from the repository root: node desktop/tests/copy.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(DESKTOP, 'copy-frontend.mjs');
const PAGE = "<!doctype html><script>const COVER_IDS = ['book', 'work', 'paper'];</script>";

// A repository with the page and its three covers, plus whatever `change` does.
function layout(change = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plain-sight-copy-'));
  mkdirSync(path.join(root, 'desktop'));
  copyFileSync(SCRIPT, path.join(root, 'desktop', 'copy-frontend.mjs'));
  writeFileSync(path.join(root, 'index.html'), PAGE);
  mkdirSync(path.join(root, 'covers'));
  for (const id of ['book', 'work', 'paper']) writeFileSync(path.join(root, 'covers', id + '.js'), 'export default {};\n');
  change(root);
  return root;
}
function copy(root) {
  const r = spawnSync(process.execPath, [path.join(root, 'desktop', 'copy-frontend.mjs')], { encoding: 'utf8' });
  const out = path.join(root, 'desktop', 'frontend');
  const files = [];
  const walk = (dir, rel) => { for (const n of readdirSync(dir)) { const p = path.join(dir, n); try { readdirSync(p); walk(p, rel + n + '/'); } catch { files.push(rel + n); } } };
  if (existsSync(out)) walk(out, '');
  return { status: r.status, log: r.stdout + r.stderr, files: files.sort() };
}
const FOUR = ['covers/book.js', 'covers/paper.js', 'covers/work.js', 'index.html'];

const tests = [];
const test = (name, change, check) => tests.push({ name, change, check });
const refused = (r) => { assert.equal(r.status, 1, r.log); assert.deepEqual(r.files, [], 'nothing copied'); assert.match(r.log, /Nothing was copied/); };

test('the page and the three covers it names are copied, and nothing else', () => {}, (r) => { assert.equal(r.status, 0, r.log); assert.deepEqual(r.files, FOUR); });
test('a Finder .DS_Store is left out and logged', (root) => writeFileSync(path.join(root, 'covers', '.DS_Store'), 'x'), (r) => { assert.equal(r.status, 0, r.log); assert.deepEqual(r.files, FOUR); assert.match(r.log, /\.DS_Store\s+skipped/); });
test('a script the page does not name is refused', (root) => writeFileSync(path.join(root, 'covers', 'evil.js'), 'x'), refused);
test('a hidden script is refused', (root) => writeFileSync(path.join(root, 'covers', '.hidden.js'), 'x'), refused);
test('a stray file is refused', (root) => writeFileSync(path.join(root, 'covers', 'notes.txt'), 'x'), refused);
test('a subfolder is refused', (root) => mkdirSync(path.join(root, 'covers', 'more')), refused);
test('a missing cover is refused', (root) => rmSync(path.join(root, 'covers', 'work.js')), refused);
test('a cover that is a symbolic link is refused', (root) => { rmSync(path.join(root, 'covers', 'book.js')); symlinkSync('/etc/hosts', path.join(root, 'covers', 'book.js')); }, refused);
test('a covers folder that is a symbolic link is refused', (root) => {
  const elsewhere = path.join(root, 'elsewhere');
  mkdirSync(elsewhere);
  for (const id of ['book', 'work', 'paper']) writeFileSync(path.join(elsewhere, id + '.js'), 'x');
  rmSync(path.join(root, 'covers'), { recursive: true });
  symlinkSync(elsewhere, path.join(root, 'covers'));
}, refused);
test('a missing index.html is refused', (root) => rmSync(path.join(root, 'index.html')), refused);
test('a page that lists no covers is refused', (root) => writeFileSync(path.join(root, 'index.html'), '<!doctype html>'), refused);
test('an unreadable cover stops the copy and leaves no half copy', (root) => chmodSync(path.join(root, 'covers', 'paper.js'), 0o000), refused);
test('a file left from an older copy is gone after a new copy', (root) => {
  mkdirSync(path.join(root, 'desktop', 'frontend', 'covers'), { recursive: true });
  writeFileSync(path.join(root, 'desktop', 'frontend', 'covers', 'removed-cover.js'), 'x');
}, (r) => { assert.equal(r.status, 0, r.log); assert.deepEqual(r.files, FOUR); });
test('an old copy is removed even when the new one is refused', (root) => {
  mkdirSync(path.join(root, 'desktop', 'frontend'));
  writeFileSync(path.join(root, 'desktop', 'frontend', 'old.js'), 'x');
  writeFileSync(path.join(root, 'covers', 'evil.js'), 'x');
}, refused);

let passed = 0;
let failed = 0;
for (const t of tests) {
  const root = layout(t.change);
  try {
    t.check(copy(root));
    passed += 1;
    console.log('ok   - ' + t.name);
  } catch (err) {
    failed += 1;
    console.log('FAIL - ' + t.name);
    console.log('       ' + String(err && err.message ? err.message : err).split('\n').join('\n       '));
  } finally {
    try { chmodSync(path.join(root, 'covers', 'paper.js'), 0o644); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
