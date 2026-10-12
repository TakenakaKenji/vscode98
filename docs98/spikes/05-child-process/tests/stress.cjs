// Throughput / latency / robustness of the child_process shim. Runs unchanged under Node (reference) and under qjs-spike5 + fork_main.mjs; prints one JSON line.
const cp = require('child_process'), path = require('path');
const R = { runtime: typeof process.versions.quickjs === 'string' ? 'quickjs' : 'node' }; const ms = () => Number(process.hrtime.bigint ? process.hrtime.bigint() / 1000n : 0n) / 1000;
const now = () => Date.now(), time = async (key, fn) => { const t = performance.now(); const v = await fn(); R[key] = Math.round((performance.now() - t) * 10) / 10; return v; };
const run = (file, args, opts, input) => new Promise((res, rej) => { const c = cp.spawn(file, args, opts); const out = []; let n = 0; c.stdout && c.stdout.on('data', d => { out.push(d); n += d.length; }); c.on('error', rej); c.on('close', (code, sig) => res({ code, sig, bytes: n, out })); if (input !== undefined && c.stdin) { c.stdin.on('error', () => { }); c.stdin.end(input); } });
(async () => {
	// 1. spawn latency: 100 sequential `true`
	await time('spawn100TrueMs', async () => { for (let i = 0; i < 100; i++) { await run('true', [], {}); } });
	// 2. stdin -> cat -> stdout, 32 MB (backpressure both ways)
	const big = Buffer.alloc(32 * 1024 * 1024, 'x');
	let r = await time('cat32MBMs', () => run('cat', [], {}, big)); R.cat32MBBytes = r.bytes;
	// 3. child writes 64 MB to stdout
	r = await time('yes64MBMs', () => run('sh', ['-c', 'head -c 67108864 /dev/zero'], {})); R.yes64MBBytes = r.bytes;
	// 4. 16 concurrent children
	await time('concurrent16Ms', () => Promise.all(Array.from({ length: 16 }, (_, i) => run('sh', ['-c', `sleep 0.2; echo ${i}`], {}))));
	// 5. execFile / exec callbacks, timeout, maxBuffer, non-zero exit
	const ef = (f, a, o) => new Promise(res => cp.execFile(f, a, o, (e, so, se) => res({ code: e && e.code, killed: e && e.killed, signal: e && e.signal, so: String(so).length, se: String(se).trim() })));
	R.execFileOk = await ef('echo', ['hi'], {}); R.execFileFail = await ef('sh', ['-c', 'echo oops >&2; exit 4'], {});
	R.execFileTimeout = await ef('sleep', ['5'], { timeout: 200 }); R.execFileMaxBuffer = (await ef('sh', ['-c', 'head -c 200000 /dev/zero'], { maxBuffer: 1000 })).code;
	R.execShell = await new Promise(res => cp.exec('echo $((6*7)) && echo err >&2', (e, so, se) => res([String(so).trim(), String(se).trim()])));
	// 6. spawnSync / execFileSync / execSync
	const s = cp.spawnSync('sh', ['-c', 'cat; echo done >&2'], { input: 'sync input ✓' }); R.spawnSync = { status: s.status, out: String(s.stdout), err: String(s.stderr).trim() };
	R.spawnSyncTimeout = (() => { const t = performance.now(); const x = cp.spawnSync('sleep', ['5'], { timeout: 300 }); return { signal: x.signal, code: x.error && x.error.code, ms: Math.round(performance.now() - t) }; })();
	R.execSync = String(cp.execSync('echo from-execSync')).trim(); try { cp.execFileSync('sh', ['-c', 'exit 3'], { stdio: 'ignore' }); } catch (e) { R.execFileSyncStatus = e.status; }
	R.spawnSyncBig = (() => { const x = cp.spawnSync('sh', ['-c', 'head -c 8000000 /dev/zero; head -c 300000 /dev/zero >&2']); return [x.stdout.length, x.stderr.length]; })();
	// 7. IPC: 2000 small round trips, then 20 MB of messages one way
	const kid = cp.fork(path.join(__dirname, 'ipc_echo_child.cjs'), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
	await time('ipcStartMs', () => new Promise(res => kid.once('message', res)));
	await time('ipc2000RoundTripsMs', () => new Promise(res => { let n = 0; kid.on('message', function h(m) { if (m.k === 'echo' && ++n === 2000) { kid.off('message', h); res(); } else if (m.k === 'echo') { kid.send({ k: 'echo', n }); } }); kid.send({ k: 'echo', n: 0 }); }));
	await time('ipc20MBMs', () => new Promise(res => { const chunk = 'y'.repeat(100000); let got = 0; kid.on('message', function h(m) { if (m.k === 'count') { kid.off('message', h); got = m.bytes; res(); } }); for (let i = 0; i < 200; i++) { kid.send({ k: 'data', s: chunk }); } kid.send({ k: 'report' }); })); 
	R.ipcBytesSeenByChild = await new Promise(res => { kid.once('message', m => res(m.bytes)); kid.send({ k: 'report' }); });
	kid.disconnect(); await new Promise(res => kid.once('exit', res));
	// 8. child killed by a signal
	const k2 = cp.spawn('sleep', ['30']); await new Promise(res => { k2.on('exit', (c, sg) => { R.killedBy = sg; res(); }); setTimeout(() => k2.kill('SIGKILL'), 50); });
	R.done = true; console.log(JSON.stringify(R)); process.exit(0);
})().catch(e => { console.log('FAILED ' + (e && e.stack || e)); process.exit(1); });
