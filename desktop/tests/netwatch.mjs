// Watches the desktop app for network use while other tests drive it: every
// half second it lists the internet sockets of the app's own processes and of
// the WebKit networking process that works for the app (found by the app's
// web data folder it has open), and at the end it asks nettop for any flow
// those processes had. Run it in the background around a test run:
//
//   node tests/netwatch.mjs <seconds> <report.json>
//
// Exit code 0: no socket and no flow seen; 1: something was seen (see the
// report); 2: the app was never seen running, so nothing was proven.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [seconds = '600', report = 'netwatch.json'] = process.argv.slice(2);
const deadline = Date.now() + Number(seconds) * 1000;
const DATA = /\/Library\/WebKit\/(com\.pranavongole\.plainsight|plain-sight)\//;
// Which processes are the app. NETWATCH_APP replaces the pattern only for the
// positive control that shows this watch does see a process that uses the network.
const APP = process.env.NETWATCH_APP ? new RegExp(process.env.NETWATCH_APP) : /\/(MacOS|release)\/plain-sight$/;
const FIND = process.env.NETWATCH_APP ? '.' : 'plain-sight';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (err) { return String(err.stdout || ''); } };

const appPids = new Set();
const networkPids = new Set();
const notOurs = new Set();
const sockets = [];
let samples = 0;
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });

function refresh() {
  for (const line of run('pgrep', ['-fl', FIND]).split('\n')) {
    const [pid, ...cmd] = line.trim().split(' ');
    // The app itself: the release bundle's executable or a test build's.
    if (pid && APP.test(cmd.join(' '))) appPids.add(Number(pid));
  }
  for (const line of run('pgrep', ['-f', 'com.apple.WebKit.Networking']).split('\n')) {
    const pid = Number(line.trim());
    if (!pid || networkPids.has(pid) || notOurs.has(pid)) continue;
    // A networking process works for one app; ours holds our web data open.
    if (DATA.test(run('lsof', ['-p', String(pid), '-Fn']))) networkPids.add(pid);
    else notOurs.add(pid);
  }
}

while (!stopped && Date.now() < deadline) {
  refresh();
  // Alive: signal 0 succeeds, or is refused only for lack of permission.
  const pids = [...appPids, ...networkPids].filter((p) => { try { process.kill(p, 0); return true; } catch (err) { return err.code === 'EPERM'; } });
  if (pids.length) {
    samples += 1;
    const out = run('lsof', ['-nP', '-i', '-a', '-p', pids.join(',')]).trim();
    if (out) sockets.push({ at: new Date().toISOString(), lsof: out });
  }
  await sleep(500);
}

// nettop keeps per-process totals; a process that never had a flow is not
// listed, and a listed one shows its bytes.
const flows = run('nettop', ['-P', '-L', '1', '-x', '-J', 'bytes_in,bytes_out']).split('\n')
  .filter((line) => [...appPids, ...networkPids].some((pid) => line.includes('.' + pid + ',')));

const result = {
  appPids: [...appPids], networkPids: [...networkPids], samples, sockets, nettopLinesForOurPids: flows,
  verdict: !appPids.size ? 'the app was never seen running' : sockets.length || flows.some((l) => !/,0,0,$/.test(l)) ? 'network use seen' : 'no network use seen'
};
writeFileSync(report, JSON.stringify(result, null, 2));
console.log(`netwatch: ${result.verdict}; app pids ${result.appPids.join(' ') || 'none'}, WebKit networking pids ${result.networkPids.join(' ') || 'none'}, ${samples} samples, ${sockets.length} with sockets, ${flows.length} nettop lines for these pids`);
process.exit(!appPids.size ? 2 : result.verdict === 'no network use seen' ? 0 : 1);
