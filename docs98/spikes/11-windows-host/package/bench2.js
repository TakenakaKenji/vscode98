// Latency micro-benchmarks for the vscode98 host (timers, file system, big file read, compiling a big script, process creation): where does a boot spend its time when the CPU is not the limit.
// Run with run-bench2.cmd (output: results\bench2.txt).
import * as std from 'qjs:std';
import * as os from 'qjs:os';
const T = [];
function line(name, ms, extra) { T.push([name, ms]); console.log(name.padEnd(46) + String(Math.round(ms)).padStart(7) + ' ms' + (extra ? '   (' + extra + ')' : '')); }
const sleep0 = (ms) => new Promise((r) => os.setTimeout(r, ms));
const tmp = (std.getenv('TEMP') || std.getenv('TMP') || '/tmp').replace(/\\/g, '/');
const exe = scriptArgs.slice(1).find((a) => /qjs/i.test(a)) || null;
async function main() {
	let t = performance.now(); for (let i = 0; i < 1000; i++) { await sleep0(0); } line('1000 chained setTimeout(0)', performance.now() - t);
	t = performance.now(); for (let i = 0; i < 100; i++) { await sleep0(1); } line('100 chained setTimeout(1)', performance.now() - t);
	t = performance.now(); let n = 0; for (let i = 0; i < 3000; i++) { const [, err] = os.stat(tmp + '/vscode98-nonexistent-' + i); if (err) { n++; } } line('3000 stat of missing files', performance.now() - t, n + ' missing');
	t = performance.now(); n = 0; for (let i = 0; i < 3000; i++) { const [, err] = os.stat(tmp); if (!err) { n++; } } line('3000 stat of an existing directory', performance.now() - t, n + ' ok');
	// a 15 MB file: write, read whole, read in 64 KB chunks
	const f = tmp + '/vscode98-bench-15mb.js'; const chunk = '/* ' + 'x'.repeat(1021) + ' */\n'; { const fh = std.open(f, 'w'); for (let i = 0; i < 15 * 1024; i++) { fh.puts(chunk); } fh.close(); }
	t = performance.now(); const s = std.loadFile(f); line('write 15 MB + read it whole', performance.now() - t, s.length + ' chars'); t = performance.now(); const s2 = std.loadFile(f); line('read 15 MB whole (again)', performance.now() - t);
	t = performance.now(); { const fd = os.open(f, os.O_RDONLY); const buf = new ArrayBuffer(65536); let total = 0, r; while ((r = os.read(fd, buf, 0, 65536)) > 0) { total += r; } os.close(fd); line('read 15 MB in 64 KB chunks', performance.now() - t, total + ' bytes'); }
	os.remove(f);
	// compile ~15 MB of script: 15 scripts of 8000 small functions each
	{ let total = 0; t = performance.now(); for (let k = 0; k < 15; k++) { let src = ''; for (let i = 0; i < 8000; i++) { src += 'function f' + i + '(a,b){var c=a+b*' + i + ';if(c>10){return c-1}return [a,b,c].map(function(x){return x+' + i + '})}\n'; } total += src.length; (0, eval)('(function(){' + src + 'return f1})'); } line('compile ' + Math.round(total / 1048576) + ' MB of script (incl. building it)', performance.now() - t); }
	// process creation
	if (exe && typeof os.exec === "function") { t = performance.now(); let ok = 0; for (let i = 0; i < 10; i++) { const r = os.exec([exe, "-e", "1"]); if (r === 0) { ok++; } } line('10 x start qjs-win-x86.exe and wait', performance.now() - t, ok + ' ok'); }
	console.log('total'.padEnd(46) + String(Math.round(T.reduce((a, x) => a + x[1], 0))).padStart(7) + ' ms');
}
await main();
