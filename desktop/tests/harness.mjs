// Shared parts of the desktop app's end-to-end tests (app.mjs and e2e.mjs):
// the driver, the safety rules for running on someone's Mac, the app's data
// folders, the Downloads folder and a small test runner.
//
// The safety rules:
// - a run starts only while the screen is locked or after PLAIN_SIGHT_IDLE_MIN
//   seconds (default 120) without keyboard or mouse use, and stops at the
//   first touch (exit code 3), because the app's window takes the front;
// - the app's own data folders are moved aside first and put back after, so
//   a real vault or folder choice is never seen or changed by a test;
// - only files the run created are moved out of ~/Downloads, into the
//   evidence folder, matched by name and time.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESKTOP = path.resolve(HERE, '..');
export const ROOT = path.resolve(DESKTOP, '..');
export const ID = 'com.pranavongole.plainsight';
export const HOME = os.homedir();
export const DOWNLOADS = path.join(HOME, 'Downloads');
export const IDLE_MIN = Number(process.env.PLAIN_SIGHT_IDLE_MIN || 120);
export const EVIDENCE = process.env.PLAIN_SIGHT_EVIDENCE || mkdtempSync(path.join(os.tmpdir(), 'plain-sight-test-'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(path.join(EVIDENCE, 'downloads'), { recursive: true });
const logFile = createWriteStream(path.join(EVIDENCE, 'run.log'), { flags: 'a' });
export const note = (line) => logFile.write(new Date().toISOString() + ' ' + line + '\n');

// ---------------------------------------------------------------------------
// The driver, compiled once per source version into the temp folder.
// ---------------------------------------------------------------------------
const DRIVER_SRC = path.join(HERE, 'drive.swift');
const DRIVER = path.join(os.tmpdir(), 'plain-sight-drive-' + createHash('sha256').update(readFileSync(DRIVER_SRC)).digest('hex').slice(0, 12));
if (!existsSync(DRIVER)) execFileSync('swiftc', ['-O', DRIVER_SRC, '-o', DRIVER], { stdio: 'inherit' });

export function driveRaw(...args) {
  let out;
  try {
    out = execFileSync(DRIVER, args.map(String), { encoding: 'utf8', timeout: 30000 });
  } catch (err) {
    out = String(err.stdout || '');
  }
  return JSON.parse(out.trim().split('\n').pop() || '{}');
}
export function drive(...args) {
  guard();
  const result = driveRaw(...args);
  note('drive ' + args.map(String).join(' ').slice(0, 120) + ' -> ' + JSON.stringify(result).slice(0, 200));
  if (!result.ok) throw new Error('driver: ' + (result.error || JSON.stringify(result)) + ' (' + args.join(' ') + ')');
  return result;
}

// ---------------------------------------------------------------------------
// Someone at the keyboard stops the run.
// ---------------------------------------------------------------------------
export class UserActivity extends Error {}
// A test that cannot run in the Mac's present state (one that needs the app's
// window to be the key window while the screen is locked, say) throws NotRun:
// it is counted as not run, with its reason, and the tests after it still run.
export class NotRun extends Error {}
let runStart = 0;
let idleAtStart = 0;
let requireUnlocked = false;
export function guard() {
  if (!runStart) return;
  const s = driveRaw('session');
  const expected = idleAtStart + (Date.now() - runStart) / 1000;
  if (s.idle + 2 < expected) throw new UserActivity('keyboard or mouse used during the run (idle ' + Number(s.idle).toFixed(1) + ' s)');
  if (requireUnlocked && s.locked) throw new UserActivity('the screen locked during the run');
}
// Returns null when the run may start, or the reason it may not.
// Any copy of the app already running, release or test build (both are
// processes named plain-sight). A run moves the app's data aside, so it must
// never start while someone is using the app: their notes would go with it.
export function appCopiesRunning() {
  try { return execFileSync('pgrep', ['-x', 'plain-sight'], { encoding: 'utf8' }).trim().split('\n').map(Number).filter((p) => p > 0); } catch { return []; }
}
export function mayStart({ needUnlocked = false } = {}) {
  const open = appCopiesRunning();
  if (open.length) return 'the app is open (pid ' + open.join(', ') + '); close it first, since a run moves the app\'s data aside';
  const s = driveRaw('session');
  if (needUnlocked && s.locked) return 'the screen is locked; this run needs it unlocked';
  if (!s.locked && s.idle < IDLE_MIN) return `the Mac was used ${Number(s.idle).toFixed(0)} s ago; the run needs ${IDLE_MIN} s without keyboard or mouse use`;
  return null;
}
export function startGuard() {
  const s = driveRaw('session');
  runStart = Date.now();
  idleAtStart = s.idle;
  note('run started: screen ' + (s.locked ? 'locked' : 'unlocked') + ', idle ' + Number(s.idle).toFixed(0) + ' s');
}
export function stopGuard() { runStart = 0; }

export async function until(fn, what, ms = 5000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      if (err instanceof UserActivity) throw err;
      last = err;
    }
    await sleep(80);
  }
  throw new Error('timed out after ' + ms + ' ms waiting for ' + what + (last ? ': ' + last.message : ''));
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Starts an executable with its output in the evidence folder.
export function spawnApp(exe, env = {}) {
  const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  const out = createWriteStream(path.join(EVIDENCE, 'app-output.log'), { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  note('launched ' + exe + ' as pid ' + child.pid);
  return child;
}

export async function stopApp(app) {
  if (!app || !alive(app.pid)) return;
  app.child.kill('SIGTERM');
  await until(() => !alive(app.pid), 'the app to stop', 8000).catch(() => app.child.kill('SIGKILL'));
}

// ---------------------------------------------------------------------------
// The app's data folders: moved aside before the run, put back after.
// ---------------------------------------------------------------------------
const BACKUP_ROOT = path.join(HOME, 'cover-story-delivery', 'desktop', 'appdata-backup');
export const DATA_DIRS = [
  `Library/WebKit/${ID}`,
  `Library/Application Support/${ID}`,
  `Library/Caches/${ID}`,
  `Library/HTTPStorages/${ID}`,
  `Library/HTTPStorages/${ID}.binarycookies`,
  `Library/Saved Application State/${ID}.savedState`,
  // An executable run outside a bundle keeps its WebKit data under its own name.
  'Library/WebKit/plain-sight',
  'Library/Caches/plain-sight',
  // The sandboxed app (D-37) keeps all of its data in its container. macOS
  // asks the person at the Mac before a program outside the sandbox opens
  // another app's container (Apple, "Accessing files from the macOS App
  // Sandbox"), unless that program has Full Disk Access, so moving it aside
  // can put that question on screen.
  `Library/Containers/${ID}`
].map((p) => path.join(HOME, p));
let backupDir = null;
export function backupAppData() {
  if (existsSync(BACKUP_ROOT) && readdirSync(BACKUP_ROOT).length) {
    throw new Error('an earlier run left app data in ' + BACKUP_ROOT + '; put it back by hand before running again');
  }
  backupDir = path.join(BACKUP_ROOT, String(Date.now()));
  const aside = (dir) => path.join(backupDir, Buffer.from(dir).toString('base64url'));
  const moved = [];
  for (const dir of DATA_DIRS) {
    if (!existsSync(dir)) continue;
    mkdirSync(backupDir, { recursive: true });
    try {
      renameSync(dir, aside(dir));
    } catch (err) {
      // A move that macOS refuses (the container's, say) puts back what was
      // already moved, so the run stops with every folder in its place. The
      // empty backup folder is then removed, never anything with data in it.
      for (const done of moved.reverse()) renameSync(aside(done), done);
      rmSync(path.join(backupDir, 'moved.json'), { force: true });
      rmdirSync(backupDir);
      if (!readdirSync(BACKUP_ROOT).length) rmdirSync(BACKUP_ROOT);
      backupDir = null;
      throw new Error('could not move ' + dir + ' aside (' + (err.code || err.message) + '); everything was put back');
    }
    moved.push(dir);
    // Written after every move, so a run that is stopped leaves an exact record.
    writeFileSync(path.join(backupDir, 'moved.json'), JSON.stringify(moved, null, 2));
  }
  if (!moved.length) backupDir = null;
  note('app data moved aside: ' + JSON.stringify(moved));
}
export function clearTestData() {
  for (const dir of DATA_DIRS) rmSync(dir, { recursive: true, force: true });
}
export function restoreAppData() {
  clearTestData();
  if (!backupDir) return;
  const moved = JSON.parse(readFileSync(path.join(backupDir, 'moved.json'), 'utf8'));
  for (const dir of moved) renameSync(path.join(backupDir, Buffer.from(dir).toString('base64url')), dir);
  rmSync(backupDir, { recursive: true, force: true });
  if (!readdirSync(BACKUP_ROOT).length) rmSync(BACKUP_ROOT, { recursive: true, force: true });
  backupDir = null;
  note('app data restored');
}

// ---------------------------------------------------------------------------
// Downloads: only files this run created, matched by name and time.
// ---------------------------------------------------------------------------
const OURS = /^(untitled-draft|q3-planning-notes|manuscript-draft)-\d{8}-\d{4}( \(\d+\))?\.sight$|^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}( \(\d+\))?\.txt$/;
let downloadsBefore = new Set();
export function markDownloads() { downloadsBefore = new Set(readdirSync(DOWNLOADS)); }
export function newDownloads() {
  return readdirSync(DOWNLOADS).filter((n) => !downloadsBefore.has(n) && OURS.test(n) && statSync(path.join(DOWNLOADS, n)).mtimeMs >= runStartedAt - 1000);
}
let runStartedAt = Date.now();
export function collectDownloads() {
  const moved = [];
  for (const name of newDownloads()) {
    renameSync(path.join(DOWNLOADS, name), path.join(EVIDENCE, 'downloads', name));
    moved.push(name);
  }
  note('downloads moved to evidence: ' + JSON.stringify(moved));
  return moved;
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
// The novel as the engine renders it with no typos: markers consumed, one
// block per line. Visible cover text must be a prefix of this, give or take
// one wrong letter at the very end (a simulated typo waiting for its fix).
export async function novelText() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'covers', 'book.js')).href);
  const blocks = [];
  let cur = null;
  for (const raw of mod.default.text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) { cur = null; continue; }
    const marker = line.startsWith('## ') || line.startsWith('- ');
    if (marker || !cur || cur.marker) { cur = { marker, text: line.replace(/^(## |- )/, '') }; blocks.push(cur); }
    else cur.text += ' ' + line;
  }
  return blocks.map((b) => b.text).join('\n');
}
export function isCoverPrefix(visible, full) {
  return full.startsWith(visible) || full.startsWith(visible.slice(0, -1));
}

// Decrypts a .sight file or vault record outside the app, to prove what it saved.
export async function decryptRecord(record, password) {
  const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', salt: Buffer.from(record.salt, 'base64'), iterations: record.iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(record.iv, 'base64') }, key, Buffer.from(record.data, 'base64')));
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
// One GUI run at a time on this Mac: two would fight over the app's data
// folders, the Downloads folder and the front window.
const LOCK = path.join(HOME, 'cover-story-delivery', 'desktop', '.gui-test.lock');
function takeLock(name) {
  mkdirSync(path.dirname(LOCK), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Created only if it does not exist yet, so two runs cannot both take it.
      writeFileSync(LOCK, process.pid + ' ' + name + ' ' + new Date().toISOString(), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(LOCK, 'utf8').split(' ')[0]);
      if (holder && alive(holder)) return false;
      rmSync(LOCK, { force: true });   // left by a run that no longer exists
    }
  }
  return false;
}
function dropLock() {
  if (existsSync(LOCK) && Number(readFileSync(LOCK, 'utf8').split(' ')[0]) === process.pid) rmSync(LOCK);
}

export async function run(tests, { name, needUnlocked = false, before = () => {}, after = async () => {} }) {
  const only = process.env.PLAIN_SIGHT_ONLY ? new RegExp(process.env.PLAIN_SIGHT_ONLY) : null;
  if (!driveRaw('trusted').accessibility) { console.log('Accessibility permission is missing for the program running the tests. Errors: 1'); process.exit(1); }
  const reason = mayStart({ needUnlocked });
  if (reason) { console.log(`${name}: not started: ${reason}. Errors: 0`); process.exit(4); }
  if (!takeLock(name)) { console.log(`${name}: not started: another GUI test run holds ${LOCK}. Errors: 0`); process.exit(5); }
  requireUnlocked = needUnlocked;
  // Ctrl+C or a kill still puts everything back: the app stops, its data and
  // the Downloads folder are restored, the lock is released.
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    stopGuard();
    try { await after(); } catch (err) { note('after: ' + err.message); }
    try { collectDownloads(); } catch (err) { note('downloads: ' + err.message); }
    try { restoreAppData(); } catch (err) { console.log('Could not restore app data: ' + err.message); }
    dropLock();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { note('stopped by ' + signal); cleanup().finally(() => process.exit(130)); });
  }
  markDownloads();
  runStartedAt = Date.now();
  backupAppData();
  startGuard();
  let passed = 0, failed = 0, notRun = 0, stopped = null;
  try {
    await before();
    for (const t of tests) {
      if (only && !only.test(t.name)) continue;
      if (stopped) { notRun += 1; console.log('skip - ' + t.name + ' (not run: ' + stopped + ')'); continue; }
      try {
        await t.fn();
        passed += 1;
        console.log('ok   - ' + t.name);
      } catch (err) {
        if (err instanceof UserActivity) { stopped = err.message; notRun += 1; console.log('stop - ' + t.name + ' (' + err.message + ')'); continue; }
        if (err instanceof NotRun) { notRun += 1; console.log('skip - ' + t.name + ' (not run: ' + err.message + ')'); continue; }
        failed += 1;
        console.log('FAIL - ' + t.name);
        console.log('       ' + String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n       '));
      }
    }
  } finally {
    await cleanup();
  }
  console.log(`\nEvidence: ${EVIDENCE}`);
  console.log(`${passed} passed, ${failed} failed, ${notRun} not run, ${passed + failed + notRun} total. Errors: ${failed}`);
  const code = stopped ? 3 : failed ? 1 : 0;
  console.log('Exit code: ' + code);
  process.exit(code);
}
