// Static checks of the desktop app's configuration: the promises the shell
// makes in its config files, checked on every `npm test` so an edit that
// breaks one fails at once instead of in a built app.
//
// Run from the repository root: node desktop/tests/config.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const TAURI = path.join(DESKTOP, 'src-tauri');
const read = (...p) => readFileSync(path.join(...p), 'utf8');
const conf = JSON.parse(read(TAURI, 'tauri.conf.json'));
const cargo = read(TAURI, 'Cargo.toml');

// The [section] of a TOML file as key = value text, or null.
function tomlSection(text, name) {
  const start = text.indexOf('[' + name + ']\n');
  if (start < 0) return null;
  const rest = text.slice(start + name.length + 3);
  const end = rest.search(/^\[/m);
  return end < 0 ? rest : rest.slice(0, end);
}

// The app's own commands, from build.rs.
function declaredCommands() {
  const m = read(TAURI, 'build.rs').match(/\.commands\(&\[([^\]]*)\]\)/);
  assert.ok(m, 'build.rs declares the app commands with AppManifest::commands');
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the release profile builds the smallest app (DR-06)', () => {
  const profile = tomlSection(cargo, 'profile.release');
  assert.ok(profile, 'Cargo.toml has a [profile.release] section');
  for (const line of ['codegen-units = 1', 'lto = true', 'opt-level = "s"', 'panic = "abort"', 'strip = true']) {
    assert.ok(profile.split('\n').map((l) => l.trim()).includes(line), 'the release profile has ' + line);
  }
});

test('the shell serves exactly the page\'s own content security policy and adds nothing to it (DR-04)', () => {
  const meta = read(ROOT, 'index.html').match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(meta, 'index.html carries its policy');
  assert.equal(conf.app.security.csp, meta[1]);
  assert.equal(conf.app.security.dangerousDisableAssetCspModification, true, 'no nonces or hashes added');
  assert.equal(conf.app.security.freezePrototype, true);
  assert.equal(conf.app.withGlobalTauri, false);
  assert.equal(conf.build.devUrl, undefined, 'no development server: dev serves the copied files like the release');
});

test('no updater, no telemetry plugin, no remote content in the config (DR-04)', () => {
  assert.equal(conf.plugins, undefined, 'no plugin configuration at all');
  assert.notEqual(conf.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(conf.app.windows, [], 'the window is built in Rust with its handlers');
  assert.match(conf.build.frontendDist, /^\.\.\/frontend$/, 'the app serves the copied page, not a URL');
});

test('the capability grants only the app\'s own commands to the main window, on the app\'s own origin (D-10)', () => {
  const files = readdirSync(path.join(TAURI, 'capabilities'));
  assert.deepEqual(files, ['main.json'], 'one capability file');
  const cap = JSON.parse(read(TAURI, 'capabilities', 'main.json'));
  assert.deepEqual(cap.windows, ['main']);
  assert.equal(cap.local, true);
  assert.equal(cap.remote, undefined, 'no remote origin');
  const granted = cap.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));
  for (const p of granted) assert.match(p, /^allow-[a-z-]+$/, 'only app command permissions, no core: or plugin permission: ' + p);
  assert.deepEqual(granted.map((p) => p.slice('allow-'.length).replace(/-/g, '_')).sort(), declaredCommands(), 'every declared command is granted and nothing else');
});

test('the shell links no network crate and no Tauri plugin beyond the folder picker (DR-04, DR-06)', () => {
  const deps = cargo.split('\n').filter((l) => /^[a-z0-9_-]+\s*=/.test(l.trim())).map((l) => l.trim().split(/\s*=/)[0]);
  for (const d of deps) {
    assert.ok(!/^(reqwest|hyper|ureq|isahc|curl|rustls|native-tls|openssl|tungstenite|websocket)/.test(d), 'no network crate: ' + d);
    assert.ok(!d.startsWith('tauri-plugin-') || d === 'tauri-plugin-dialog', 'no Tauri plugin except the folder picker: ' + d);
  }
});

test('the web deployment allowlist is unchanged (DR-10)', () => {
  const lines = read(ROOT, '.vercelignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['*', '!index.html', '!covers', '!covers/**']);
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
    console.log('       ' + String(err && err.message ? err.message : err).split('\n').join('\n       '));
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total. Errors: ${failed}`);
process.exit(failed ? 1 : 0);
