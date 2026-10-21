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

// A strict reader for the two small property lists the shell ships,
// Entitlements.plist and container-migration.plist: a dict, arrays, strings,
// true and false only. Anything else, a comment or a key given twice
// included, is refused, so nothing in them can go unread.
function readPlist(text) {
  const header = /^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">\s*<plist version="1\.0">/;
  assert.match(text, header, 'a property list');
  const tokens = text.replace(header, '').match(/<[^>]*>|[^<]+/g).filter((t) => t.trim());
  let i = 0;
  const value = () => {
    const t = tokens[i++];
    if (t === '<true/>') return true;
    if (t === '<false/>') return false;
    if (t === '<string>') {
      const s = tokens[i] === '</string>' ? '' : tokens[i++];
      assert.equal(tokens[i++], '</string>', 'a string ends');
      return s;
    }
    if (t === '<array>') {
      const items = [];
      while (tokens[i] !== '</array>') items.push(value());
      i += 1;
      return items;
    }
    if (t === '<dict>') {
      const dict = {};
      while (tokens[i] !== '</dict>') {
        assert.equal(tokens[i++], '<key>', 'a dict holds keys');
        const key = tokens[i++];
        assert.equal(tokens[i++], '</key>', 'a key ends');
        assert.ok(!Object.hasOwn(dict, key), 'no key twice: ' + key);
        dict[key] = value();
      }
      i += 1;
      return dict;
    }
    throw new Error('not allowed in the property list: ' + t);
  };
  const root = value();
  assert.deepEqual(tokens.slice(i), ['</plist>'], 'nothing after the property list');
  return root;
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

// Every line inside a dependencies table of Cargo.toml, [dependencies] and
// [x.dependencies.name] alike.
function dependencyLines() {
  const lines = [];
  let inDeps = false;
  for (const raw of cargo.split('\n')) {
    const line = raw.trim();
    const header = line.match(/^\[(.+)\]$/);
    if (header) { inDeps = /(^|\.)(build-|dev-)?dependencies(\.|$)/.test(header[1].replace(/'[^']*'/g, '')); continue; }
    if (inDeps && line && !line.startsWith('#')) lines.push(line);
  }
  return lines;
}

test('the shell links no network crate and no Tauri plugin beyond the folder picker (DR-04, DR-06)', () => {
  const deps = dependencyNames();
  assert.ok(deps.includes('tauri') && deps.includes('rfd'), 'the dependency list was read: ' + deps.join(', '));
  for (const d of deps) {
    assert.ok(!/^(reqwest|hyper|ureq|isahc|curl|rustls|native-tls|openssl|tungstenite|websocket|h2|surf|attohttpc)([-_].*)?$/.test(d), 'no network crate: ' + d);
    assert.ok(!d.startsWith('tauri-plugin-'), 'no Tauri plugin: ' + d);
  }
});

test('every crate comes from crates.io under its own name: no renamed, git, path or patched dependency (QA-C-05)', () => {
  // A renamed dependency (name = { package = "reqwest" }) would slip past the
  // name check above; a git, path or patched source would bypass the pinned
  // registry versions. The bundle check reads the resolved build graph too.
  const source = /(^|[{,])\s*(package|git|path|registry|branch|rev|tag)\s*=/;
  for (const line of dependencyLines()) assert.ok(!source.test(line), 'no renamed or non-registry dependency: ' + line);
  assert.ok(!/^\[(patch|replace)([.\]])/m.test(cargo), 'no [patch] or [replace] section');
  const lock = read(TAURI, 'Cargo.lock');
  const sources = [...lock.matchAll(/^source = "([^"]+)"$/gm)].map((m) => m[1]);
  assert.ok(sources.length > 100, 'the lock file was read: ' + sources.length + ' sources');
  for (const src of new Set(sources)) assert.equal(src, 'registry+https://github.com/rust-lang/crates.io-index', 'every locked crate is from crates.io');
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
  for (const key of ['resources', 'externalBin', 'fileAssociations']) assert.equal(conf.bundle[key], undefined, 'nothing else bundled: bundle.' + key);
  assert.equal(conf.bundle.macOS.frameworks, undefined, 'no extra frameworks');
  // Tauri merges src-tauri/Info.plist, or the one named here, into the app's.
  assert.equal(conf.bundle.macOS.infoPlist, undefined, 'no Info.plist merged in');
  assert.ok(!readdirSync(TAURI).includes('Info.plist'), 'no src-tauri/Info.plist merged in');
});

test('the app runs in the App Sandbox with exactly its four entitlements, none for the network (D-37, D-14)', () => {
  assert.equal(conf.bundle.macOS.entitlements, './Entitlements.plist');
  assert.notEqual(conf.bundle.macOS.hardenedRuntime, false, 'the hardened runtime stays on');
  assert.deepEqual(readPlist(read(TAURI, 'Entitlements.plist')), {
    'com.apple.security.app-sandbox': true,
    // The folder panel (folder.rs) and the page's Open panel.
    'com.apple.security.files.user-selected.read-write': true,
    // Save without a folder writes into Downloads (save_download).
    'com.apple.security.files.downloads.read-write': true,
    // The remembered folder is a security-scoped bookmark (bookmark.rs).
    'com.apple.security.files.bookmarks.app-scope': true
  });
});

test('the one bundled resource moves the vault and the app\'s data folder into the container at the first sandboxed launch (D-37)', () => {
  assert.deepEqual(conf.bundle.macOS.files, { 'Resources/container-migration.plist': './container-migration.plist' }, 'one file, in Contents/Resources');
  const id = conf.identifier;
  assert.deepEqual(readPlist(read(TAURI, 'container-migration.plist')), {
    Move: [
      // WebKit keeps a sandboxed app's web data, the vault included, in
      // Library/WebKit/WebsiteData, without the bundle identifier it uses
      // outside the sandbox (WebKit, WebsiteDataStoreCocoa.mm), so the
      // folder moves to that place in the container.
      ['${Library}/WebKit/' + id + '/WebsiteData', '${Library}/WebKit/WebsiteData'],
      // The app's data folder keeps its place, under the container.
      '${ApplicationSupport}/' + id
    ]
  });
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
