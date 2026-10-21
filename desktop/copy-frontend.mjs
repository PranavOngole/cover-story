// Copies the web page into desktop/frontend/, the folder the app serves.
//
// This is an allowlist on purpose: the app bundles index.html and the cover
// modules the page itself names (COVER_IDS in index.html) and nothing else
// from the repository, so a tool or agent folder, or a stray script in covers/,
// can never reach the app. The web deployment follows the same idea in
// .vercelignore.
//
// Anything unexpected stops the copy with an error instead of being bundled or
// quietly skipped, so a person notices it. The one exception is .DS_Store,
// which Finder writes into any folder it shows: it is left out and the log
// says so. A copy that fails halfway leaves no frontend folder behind.

import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths are resolved from this file, not from the current directory, so the
// script does the same thing whichever directory it is started from.
const desktop = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(desktop, '..');
const out = path.join(desktop, 'frontend');

function fail(reason) {
  rmSync(out, { recursive: true, force: true });
  console.error('copy-frontend: ' + reason + '. Nothing was copied.');
  process.exit(1);
}

// Plain files and folders only: a symbolic link could pull in something else.
const isRegularFile = (p) => { try { return lstatSync(p).isFile(); } catch { return false; } };
const isRealFolder = (p) => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

// Start from nothing, so a file removed from the repository also leaves the
// app, and a failed check below leaves no old copy behind for a build to use.
rmSync(out, { recursive: true, force: true });

// Check everything before copying anything.
if (!isRegularFile(path.join(repo, 'index.html'))) fail('index.html is missing or is not a regular file');
const page = readFileSync(path.join(repo, 'index.html'), 'utf8');
const ids = page.match(/const COVER_IDS = \[([^\]]*)\];/);
if (!ids) fail('index.html does not list its covers (COVER_IDS)');
const covers = [...ids[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] + '.js').sort();
if (!covers.length) fail('index.html lists no covers');
if (!isRealFolder(path.join(repo, 'covers'))) fail('covers is missing or is not a real folder');
const present = readdirSync(path.join(repo, 'covers')).filter((name) => name !== '.DS_Store').sort();
if (present.length !== readdirSync(path.join(repo, 'covers')).length) console.log('covers/.DS_Store  skipped (Finder metadata, never bundled)');
for (const name of present) if (!covers.includes(name)) fail('covers/' + name + ' is not one of the covers index.html names');
for (const name of covers) if (!isRegularFile(path.join(repo, 'covers', name))) fail('covers/' + name + ' is missing or is not a regular file');

try {
  for (const rel of ['index.html', ...covers.map((name) => 'covers/' + name)]) {
    const to = path.join(out, rel);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(repo, rel), to);
    // Size and hash of the copy itself, so the log shows exactly what the app got.
    const bytes = readFileSync(to);
    console.log(rel + '  ' + bytes.length + ' bytes  sha256 ' + createHash('sha256').update(bytes).digest('hex'));
  }
} catch (err) {
  fail('a file could not be copied (' + (err && err.code ? err.code : err) + ')');
}
