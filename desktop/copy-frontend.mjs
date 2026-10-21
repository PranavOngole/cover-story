// Copies the web page into desktop/frontend/, the folder the app serves.
//
// This is an allowlist on purpose: the app bundles index.html and the cover
// modules in covers/ and nothing else from the repository, so a tool or agent
// folder that appears in the repository can never reach the app. The web
// deployment follows the same rule in .vercelignore.
//
// Anything unexpected in covers/ stops the copy with an error instead of being
// bundled or quietly skipped, so a stray file is noticed by a person.

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
  console.error('copy-frontend: ' + reason + '. Nothing was copied.');
  process.exit(1);
}

// A plain file only: a folder or a symbolic link could pull in something else.
function isRegularFile(p) {
  try { return lstatSync(p).isFile(); } catch { return false; }
}

// Start from nothing, so a file removed from the repository also leaves the
// app, and a failed check below leaves no old copy behind for a build to use.
rmSync(out, { recursive: true, force: true });

// Check every file before copying any of them.
if (!isRegularFile(path.join(repo, 'index.html'))) fail('index.html is missing or is not a regular file');
let covers;
try { covers = readdirSync(path.join(repo, 'covers')).sort(); } catch { fail('the covers folder is missing'); }
const files = ['index.html'];
for (const name of covers) {
  const rel = 'covers/' + name;
  if (!name.endsWith('.js') || !isRegularFile(path.join(repo, rel))) fail(rel + ' is not a regular .js file');
  files.push(rel);
}

for (const rel of files) {
  const to = path.join(out, rel);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(path.join(repo, rel), to);
  // Size and hash of the copy itself, so the log shows exactly what the app got.
  const bytes = readFileSync(to);
  console.log(rel + '  ' + bytes.length + ' bytes  sha256 ' + createHash('sha256').update(bytes).digest('hex'));
}
