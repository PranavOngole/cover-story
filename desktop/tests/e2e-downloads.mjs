// Loaded by e2e.mjs before the harness: names the folder the test build
// writes downloads into, under the evidence directory, so that a run of the
// end-to-end tests never writes into the real ~/Downloads (Mac_PS_010). The
// test build takes PLAIN_SIGHT_E2E_DOWNLOADS in place of the Downloads folder
// (src-tauri/src/folder.rs, e2e feature only; the release app has no such
// override), and the harness's DOWNLOADS follows the same variable. The
// evidence directory is fixed here too, so this module and the harness agree.
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PLAIN_SIGHT_EVIDENCE ||= mkdtempSync(path.join(os.tmpdir(), 'plain-sight-test-'));
process.env.PLAIN_SIGHT_E2E_DOWNLOADS ||= path.join(process.env.PLAIN_SIGHT_EVIDENCE, 'downloads-folder');
mkdirSync(process.env.PLAIN_SIGHT_E2E_DOWNLOADS, { recursive: true });
