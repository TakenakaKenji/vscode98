// Control benchmark: Electron VS Code startup to "explorer lists the workspace" and the memory of its process tree a while later.
// Usage: node electron_start.mjs <electron exe> <user-data-dir> <ext dir> <workspace> [taskset cpus]
import { spawn, execSync } from 'node:child_process';
import { connectPage } from './cdp_page.mjs';
const [exe, ud, ext, ws, cpus] = process.argv.slice(2);
const t0 = Date.now();
const args = ['--no-sandbox', ...(process.env.DISPLAY ? [] : ['--ozone-platform=headless']), '--disable-gpu', '--remote-debugging-port=9334', `--user-data-dir=${ud}`, `--extensions-dir=${ext}`, '--disable-telemetry', ws];
const child = cpus ? spawn('taskset', ['-c', cpus, exe, ...args], { stdio: 'ignore', detached: true }) : spawn(exe, args, { stdio: 'ignore', detached: true });
const page = await connectPage(9334, (t) => /workbench\.html/.test(t.url)); const tCdp = Date.now() - t0;
await page.waitForFunction(() => [...document.querySelectorAll('.explorer-folders-view .monaco-list-row')].some((r) => /hello\.txt/.test(r.getAttribute('aria-label') || '')), null, { polling: 100, timeout: 120000 });
const tReady = Date.now() - t0;
await new Promise((r) => setTimeout(r, 30000));
const rss = (pid) => { const out = execSync(`ps -o pid=,ppid=,rss=,comm= -e`).toString().trim().split('\n').map((l) => l.trim().split(/\s+/)); const kids = (p) => out.filter((r) => r[1] === String(p)); let sum = 0, n = 0; const walk = (p) => { for (const r of kids(p)) { sum += Number(r[2]); n++; walk(r[0]); } }; walk(pid); return { mb: Math.round(sum / 1024), processes: n }; };
console.log('ctl: electron startup ' + JSON.stringify({ cdpUp: tCdp, explorerReady: tReady, after30s: rss(child.pid) }));
page.close(); try { process.kill(-child.pid, 'SIGTERM'); } catch { }
process.exit(0);
