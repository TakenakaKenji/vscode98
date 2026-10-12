// Raw test of spike:proc on Windows (no Node shims): parent spawns itself as a child with stdin/stdout pipes and a duplex IPC pipe, exchanges messages, checks exit codes,
// kill, pollSync and the "no more events" loop exit. Run: qjs-win-x86.exe proc_raw.mjs   (the same file is the child when called with "child")
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import * as p from 'spike:proc';
const dec = (ab, n) => __utf8Decode(new Uint8Array(ab, 0, n)), enc = (s) => __utf8Encode(s);
const out = (s) => { std.out.puts(s + '\n'); std.out.flush(); };
if (scriptArgs[1] === 'child') {
	const mode = scriptArgs[2];
	if (mode === 'echo') {                                   // echo stdin to stdout upper-cased, plus IPC greeting on fd 3
		const ipcBuf = new ArrayBuffer(4096); const stdinBuf = new ArrayBuffer(65536);
		const w3 = (s) => { const b = enc(s); p.write(3, b.buffer, 0, b.length); };
		w3('hello-from-child pid=' + p.getpid() + '\n');
		p.setReadHandler(3, () => { const n = p.read(3, ipcBuf, 0, 4096); if (n <= 0) { p.setReadHandler(3, null); return; } w3('ack:' + dec(ipcBuf, n)); });
		p.setReadHandler(0, () => { const n = p.read(0, stdinBuf, 0, 65536); if (n <= 0) { p.setReadHandler(0, null); p.close(3); return; } const b = enc(dec(stdinBuf, n).toUpperCase()); p.write(1, b.buffer, 0, b.length); });
	} else if (mode === 'exit7') { std.exit(7); }
	else if (mode === 'sleep') { os.sleep(60000); }
	else if (mode === 'big') { const b = enc('x'.repeat(65536)); for (let i = 0; i < 40; i++) { let off = 0; while (off < b.length) { const n = p.write(1, b.buffer, off, b.length - off); if (n < 0) { std.exit(3); } off += n; } } }
} else {
	const self = p.exePath(); let fails = 0; const check = (name, ok, extra = '') => { out(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!ok) { fails++; } };
	const args = (mode) => [self, '--stack-size', '0', scriptArgs[0], 'child', mode];
	// 1. stdio pipes + IPC + exit watching on the event loop
	const [inR, inW] = p.pipe(0), [outR, outW] = p.pipe(1), [ipcA, ipcB] = p.socketpair();
	const pid = p.spawn({ file: self, args: args('echo'), env: undefined, fds: [inR, outW, -1, ipcB] });
	check('spawn returns a pid', pid > 0, 'pid=' + pid);
	p.close(inR); p.close(outW); p.close(ipcB);
	let got = '', ipcGot = '', exited = null; const rb = new ArrayBuffer(65536), ib = new ArrayBuffer(4096);
	p.setReadHandler(outR, () => { const n = p.read(outR, rb, 0, 65536); if (n <= 0) { p.setReadHandler(outR, null); return; } got += dec(rb, n); });
	p.setReadHandler(ipcA, () => { const n = p.read(ipcA, ib, 0, 4096); if (n <= 0) { p.setReadHandler(ipcA, null); return; } ipcGot += dec(ib, n); });
	p.watchExit(pid, (code, killed) => { exited = { code, killed }; });
	const w = (fd, s) => { const b = enc(s); return p.write(fd, b.buffer, 0, b.length); };
	w(inW, 'hello world\n'); w(ipcA, 'ping1\n');
	os.setTimeout(() => { w(inW, 'second line\n'); w(ipcA, 'ping2\n'); }, 300);
	os.setTimeout(() => { p.close(inW); }, 800);              // EOF on the child's stdin: the child closes its IPC end and its loop ends
	os.setTimeout(() => {
		check('child stdout echoed', got === 'HELLO WORLD\nSECOND LINE\n', JSON.stringify(got));
		check('IPC both directions', ipcGot.includes('hello-from-child') && ipcGot.includes('ack:ping1') && ipcGot.includes('ack:ping2'), JSON.stringify(ipcGot));
		check('child exited with 0 (watchExit)', exited && exited.code === 0 && !exited.killed, JSON.stringify(exited));
		// 2. exit code, spawn failure
		const pid2 = p.spawn({ file: self, args: args('exit7'), fds: [-1, -1, -1] }); let e2 = null; p.watchExit(pid2, (c) => { e2 = c; });
		const bad = p.spawn({ file: 'no-such-program-xyz', args: ['no-such-program-xyz'], fds: [-1, -1, -1] }); check('spawn of a missing program fails with ENOENT', bad === -2, 'r=' + bad);
		// 3. kill
		const pid3 = p.spawn({ file: self, args: args('sleep'), fds: [-1, -1, -1] }); let e3 = null; p.watchExit(pid3, (c, k) => { e3 = { c, k }; });
		os.setTimeout(() => { check('kill(pid, 0) sees a live process', p.kill(pid3, 0) === 0); p.kill(pid3, 15); }, 200);
		os.setTimeout(() => {
			check('exit code 7', e2 === 7, 'code=' + e2); check('killed child reported as killed', e3 && e3.k === true && e3.c === 1, JSON.stringify(e3));
			// 4. backpressure: the child writes 2.5 MB to stdout, the parent reads it all
			const [r4, w4] = p.pipe(1); const pid4 = p.spawn({ file: self, args: args('big'), fds: [-1, w4, -1] }); p.close(w4); let total = 0;
			p.setReadHandler(r4, () => { const n = p.read(r4, rb, 0, 65536); if (n <= 0) { p.setReadHandler(r4, null); check('2.5 MB through a pipe', total === 40 * 65536, 'got ' + total); } else { total += n; } });
			// 5. pollSync
			const [i5, o5, e5] = [p.pipe(0), p.pipe(1), p.pipe(1)]; const pid5 = p.spawn({ file: self, args: args('echo'), fds: [i5[0], o5[1], e5[1]] }); p.close(i5[0]); p.close(o5[1]); p.close(e5[1]);
			const r5 = p.pollSync({ pid: pid5, inFd: i5[1], input: enc('sync data\n').buffer.slice(0), outFd: o5[0], errFd: e5[0], timeoutMs: 0, maxBuffer: 1 << 20 });
			check('pollSync output', dec(r5.out, r5.out.byteLength) === 'SYNC DATA\n' && r5.status === 0, JSON.stringify({ s: r5.status, o: dec(r5.out, r5.out.byteLength) }));
		}, 1200);
	}, 2000);
	os.setTimeout(() => { out(fails ? `FAILED (${fails})` : 'ALL PASSED'); std.exit(fails ? 1 : 0); }, 6000);
}
