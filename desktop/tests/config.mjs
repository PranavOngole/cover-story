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

// Every dependency name in Cargo.toml, in any of the ways TOML can write one:
// a "name = ..." line under a dependencies table, or a [*.dependencies.name] table.
function dependencyNames() {
  const names = [];
  let inDeps = false;
  for (const raw of cargo.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      const table = header[1].replace(/'[^']*'/g, '');
      const named = table.match(/dependencies\.([A-Za-z0-9_-]+)$/);
      if (named) { names.push(named[1]); inDeps = false; } else inDeps = /(^|\.)(build-|dev-)?dependencies$/.test(table);
      continue;
    }
    const entry = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (inDeps && entry) names.push(entry[1]);
  }
  return names;
}

test('the shell links no network crate and no Tauri plugin beyond the folder picker (DR-04, DR-06)', () => {
  const deps = dependencyNames();
  assert.ok(deps.includes('tauri') && deps.includes('rfd'), 'the dependency list was read: ' + deps.join(', '));
  for (const d of deps) {
    assert.ok(!/^(reqwest|hyper|ureq|isahc|curl|rustls|native-tls|openssl|tungstenite|websocket|h2|surf|attohttpc)([-_].*)?$/.test(d), 'no network crate: ' + d);
    assert.ok(!d.startsWith('tauri-plugin-'), 'no Tauri plugin: ' + d);
  }
});

test('Tauri is pinned and built without extra features; the test hook is never on by default (DM-205)', () => {
  const tauri = cargo.match(/^tauri = \{ version = "([^"]+)", features = \[([^\]]*)\] \}$/m);
  assert.ok(tauri, 'the tauri dependency line has its expected shape');
  assert.match(tauri[1], /^=\d+\.\d+\.\d+$/, 'tauri is pinned to one version');
  assert.equal(tauri[2].trim(), '', 'no tauri features (no devtools, no asset protocol)');
  for (const crate of ['tauri-build', 'rfd']) assert.match(cargo, new RegExp('^' + crate + ' = \\{ version = "=\\d', 'm'), crate + ' is pinned');
  const features = tomlSection(cargo, 'features') || '';
  assert.ok(!/^default\s*=/m.test(features), 'no default features: the e2e hook is built only when asked for');
});

test('no remote access to the app\'s commands, no asset protocol, the app and nothing stranger as targets (DM-205)', () => {
  assert.equal(conf.app.security.dangerousRemoteDomainIpcAccess, undefined);
  assert.ok(!conf.app.security.assetProtocol || conf.app.security.assetProtocol.enable !== true, 'no asset protocol');
  assert.ok(conf.bundle.targets.includes('app') && conf.bundle.targets.every((t) => t === 'app' || t === 'dmg'), 'targets: ' + conf.bundle.targets);
  assert.equal(conf.bundle.macOS.minimumSystemVersion, '11.0', 'the first macOS of Apple Silicon, which is all the build runs on');
});

test('the e2e build copies the page first, so it never embeds an old page (DM-205)', () => {
  const pkg = JSON.parse(read(DESKTOP, 'package.json'));
  assert.match(pkg.scripts['build:e2e'], /^npm run copy && cargo build --release --features e2e /);
});

test('the bundle is sealed with an ad-hoc signature until a Developer ID exists (DR-07, DM-201)', () => {
  // Without it only the binary carries the linker's signature and a downloaded
  // copy can be reported as damaged instead of unverified.
  assert.equal(conf.bundle.macOS && conf.bundle.macOS.signingIdentity, '-');
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
