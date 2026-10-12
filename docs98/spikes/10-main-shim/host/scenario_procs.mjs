// lists the process tree below the harness with RSS (MB) and the command's entry script, and the harness's own RSS
import * as std from 'qjs:std';
import * as os from 'qjs:os';
export async function run(ctx) {
	await new Promise(r => setTimeout(r, Number(ctx.opt('wait', 15)) * 1000));
	const me = Number(/Pid:\s+(\d+)/.exec(std.loadFile('/proc/self/status'))[1]); const procs = new Map();
	for (const d of os.readdir('/proc')[0]) { if (!/^\d+$/.test(d)) { continue; } const st = std.loadFile(`/proc/${d}/status`); if (!st) { continue; } const ppid = Number(/PPid:\s+(\d+)/.exec(st)[1]); const rss = Number((/VmRSS:\s+(\d+)/.exec(st) || [0, 0])[1]) / 1024; const hwm = Number((/VmHWM:\s+(\d+)/.exec(st) || [0, 0])[1]) / 1024; const cmd = (std.loadFile(`/proc/${d}/cmdline`) || '').split('\0').filter(Boolean); procs.set(Number(d), { pid: Number(d), ppid, rss, hwm, cmd }); }
	const out = []; const walk = (pid, depth) => { for (const p of procs.values()) { if (p.ppid === pid) { const script = p.cmd.find(a => /\.(mjs|js)$/.test(a) && !/fork_main/.test(a)) || p.cmd.join(' '); const tgt = (std.loadFile(`/proc/${p.pid}/environ`) || '').split('\0').find(e => e.startsWith('VSCODE_ESM_ENTRYPOINT=') || e.startsWith('UTIL_TARGET=')) || ''; out.push(`${'  '.repeat(depth)}${p.pid}  rss ${p.rss.toFixed(0)} MB (peak ${p.hwm.toFixed(0)})  ${script.split('/').pop()} ${tgt.replace(/^.*=/, '')}`); walk(p.pid, depth + 1); } } };
	const self = procs.get(me); ctx.log(`process tree (harness = renderer):\n${me}  rss ${self.rss.toFixed(0)} MB (peak ${self.hwm.toFixed(0)})  renderer harness`); walk(me, 1);
	const total = [...procs.values()].filter(p => p.pid === me || (() => { let q = p; while (q && q.ppid) { if (q.ppid === me) { return true; } q = procs.get(q.ppid); } return false; })()).reduce((s, p) => s + p.rss, 0); ctx.log(out.join('\n') + `\ntotal RSS of the tree: ${total.toFixed(0)} MB`);
}
