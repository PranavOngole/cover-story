// Black-box tests of the built app (the release bundle, no test hooks) with
// real key presses through macOS: the keyboard path into the page, the menu
// bar, the clipboard, the window and the process. They need the screen
// unlocked, so they start only when the Mac has been left alone for a while
// with the screen on (see harness.mjs), and they stop at the first touch.
// What happens inside the page is checked in e2e.mjs; here the page is read
// only through what a person can do: peek, copy, and paste the clipboard.
//
// Run from desktop/: npm run test:app   (exit code 0 only when every test passes)

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DESKTOP, EVIDENCE, alive, drive, driveRaw, note, run, sleep, until } from './harness.mjs';

const APP = process.env.PLAIN_SIGHT_APP || path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Plain Sight.app');
let app = null;   // { pid }
let frontBefore = -1;

function findPid() {
  try {
    return Number(execFileSync('pgrep', ['-f', path.join(APP, 'Contents/MacOS/plain-sight')], { encoding: 'utf8' }).trim().split('\n')[0]) || 0;
  } catch { return 0; }
}

// Opened the way a person opens it, through LaunchServices.
async function launch() {
  execFileSync('open', ['-n', APP]);
  const pid = await until(() => findPid(), 'the app process', 15000);
  app = { pid };
  note('opened pid ' + pid);
  await until(() => drive('cgwindows', pid).windows.some((w) => w.layer === 0 && w.onscreen), 'the app window', 15000);
  await until(() => drive('front', pid).ok, 'the app in front', 8000);
  await sleep(1200);   // the page and its cover module load
}

const keys = {
  type: async (text) => { drive('type', app.pid, text, 14); await sleep(200); },
  press: async (chord) => { drive('key', app.pid, chord); await sleep(250); }
};

// Puts a known value on the clipboard, then peeks and copies with real keys.
// The clipboard afterwards is what the page put there, or the marker if the
// page copied nothing.
async function copyRealText(mod = 'cmd') {
  const marker = 'clipboard marker ' + Date.now();
  execFileSync('pbcopy', [], { input: marker });
  await keys.press(mod + '+shift+g');
  await keys.press(mod + '+c');
  await keys.press(mod + '+shift+g');
  await sleep(300);
  const text = drive('clip-text').text;
  return text === marker ? null : text;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the app opens from its bundle as a normal Mac app: one window, in front, with a standard menu bar', async () => {
  await launch();
  const windows = drive('cgwindows', app.pid).windows.filter((w) => w.layer === 0 && w.onscreen);
  assert.equal(windows.length, 1);
  assert.equal(driveRaw('frontmost').pid, app.pid);
  const menus = drive('menus', app.pid).menus.map((m) => m.title);
  note('menus: ' + JSON.stringify(drive('menus', app.pid).menus));
  assert.deepEqual(menus.filter((t) => t !== 'Apple'), ['Plain Sight', 'File', 'Edit', 'View', 'Window', 'Help']);
});

test('real keys reach the page: Return starts writing, typing goes to the hidden buffer, Cmd+Shift+G then Cmd+C copies exactly it', async () => {
  await keys.press('return');   // the intro's Start button has the focus on a first launch
  await keys.type('meet me at the north gate at nine');
  assert.equal(await copyRealText('cmd'), 'meet me at the north gate at nine');
});

test('the Ctrl versions of the chords work too', async () => {
  await keys.type(' sharp');
  assert.equal(await copyRealText('ctrl'), 'meet me at the north gate at nine sharp');
});

test('Esc erases the text: a peek and a copy afterwards copy nothing', async () => {
  await keys.press('escape');
  assert.equal(await copyRealText('cmd'), null);
});

test('Backspace removes the last character from the hidden buffer', async () => {
  await keys.type('abcd');
  await keys.press('backspace');
  assert.equal(await copyRealText('cmd'), 'abc');
  await keys.press('escape');
});

test('Cmd+Q quits the app', async () => {
  await keys.press('cmd+q');
  await until(() => !alive(app.pid), 'the app to quit', 10000);
  app = null;
});

await run(tests, {
  name: 'app',
  needUnlocked: true,
  before: () => {
    frontBefore = driveRaw('frontmost').pid;
    driveRaw('clip-save', path.join(EVIDENCE, 'clipboard.plist'));
  },
  after: async () => {
    if (app && alive(app.pid)) { process.kill(app.pid, 'SIGTERM'); await sleep(1000); }
    driveRaw('clip-restore', path.join(EVIDENCE, 'clipboard.plist'));
    if (frontBefore > 0) driveRaw('front', frontBefore);
  }
});
