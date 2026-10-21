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

import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [seconds = '600', report = 'netwatch.json'] = process.argv.slice(2);
const deadline = Date.now() + Number(seconds) * 1000;
const DATA = /\/Library\/WebKit\/(com\.pranavongole\.plainsight|plain-sight)\//;
// Which processes are the app: those named plain-sight, the release bundle's
// executable and a test build's alike (by name, so a pgrep or a shell that
// names the app's path in its arguments is not taken for it). NETWATCH_APP, a
// pattern for the command line, replaces this only for the positive control
// that shows this watch does see a process that uses the network.
const APP = process.env.NETWATCH_APP ? new RegExp(process.env.NETWATCH_APP) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (err) { return String(err.stdout || ''); } };

const appPids = new Set();
const networkPids = new Set();
const notOurs = new Set();
const sockets = [];
let samples = 0;
let stopped = false;

// nettop logs every process's traffic once a second for the whole watch, so a
// connection that opens and closes between two socket samples still shows,
// and so do processes that ended before the watch did.
const nettopLines = [];
// Under a pseudo-terminal (script), so nettop writes each line at once
// instead of holding them in a buffer that a stop would lose. No -t: without
// it nettop monitors all interfaces, loopback and AWDL included.
const nettop = spawn('script', ['-q', '/dev/null', 'nettop', '-P', '-L', '0', '-s', '1', '-x', '-J', 'bytes_in,bytes_out'], { stdio: ['ignore', 'pipe', 'ignore'] });
let partial = '';
nettop.stdout.on('data', (chunk) => {
  const lines = (partial + chunk).split('\n');
  partial = lines.pop();
  for (const raw of lines) { const line = raw.replace(/\r$/, ''); if (/^[^,]*\.\d+,/.test(line)) nettopLines.push(line); }
});
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });

function refresh() {
  const found = APP ? run('pgrep', ['-fl', '.']) : run('pgrep', ['-x', 'plain-sight']);
  for (const line of found.split('\n')) {
    const [first, ...cmd] = line.trim().split(' ');
    const pid = Number(first);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && (!APP || APP.test(cmd.join(' ')))) appPids.add(pid);
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

nettop.kill('SIGTERM');
// The logged lines of our processes (name.pid,bytes_in,bytes_out,): a process
// that never had a flow is not listed, and a listed one shows its bytes.
const flows = nettopLines.filter((line) => [...appPids, ...networkPids].some((pid) => line.includes('.' + pid + ',')));

const result = {
  appPids: [...appPids], networkPids: [...networkPids], samples, sockets, nettopLinesForOurPids: flows,
  // Any listed line counts: even with no bytes yet, it means a socket existed.
  verdict: !appPids.size ? 'the app was never seen running' : sockets.length || flows.length ? 'network use seen' : 'no network use seen'
};
writeFileSync(report, JSON.stringify(result, null, 2));
console.log(`netwatch: ${result.verdict}; app pids ${result.appPids.join(' ') || 'none'}, WebKit networking pids ${result.networkPids.join(' ') || 'none'}, ${samples} samples, ${sockets.length} with sockets, ${flows.length} nettop lines for these pids`);
process.exit(!appPids.size ? 2 : result.verdict === 'no network use seen' ? 0 : 1);
