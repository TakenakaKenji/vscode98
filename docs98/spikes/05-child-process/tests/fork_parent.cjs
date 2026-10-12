// fork() a child with an IPC channel; ping-pong JSON messages, check stdio pipes, disconnect and exit events, kill.
const cp = require('child_process');
const path = require('path');
const t0 = Date.now(); const log = (...a) => console.log(String(Date.now() - t0).padStart(5), ...a);
const child = cp.fork(path.join(__dirname, 'fork_child.cjs'), ['--flag', 'arg2'], { silent: true });
let got = 0, out = '', err = '';
child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
child.on('message', (m) => {
	if (m.type === 'hello') { log('child says hello', JSON.stringify(m)); child.send({ type: 'ping', n: 1, payload: 'ünïcödé ✓ ' + 'x'.repeat(100000) }); }
	else if (m.type === 'pong') { got++; log('pong', m.n, 'len', m.len); if (m.n < 5) { child.send({ type: 'ping', n: m.n + 1, payload: 'p'.repeat(m.n * 70000) }); } else { child.send({ type: 'bye' }); } }
});
child.on('disconnect', () => log('disconnect (parent side), connected =', child.connected));
child.on('exit', (code, sig) => log('exit', code, sig));
child.on('close', (code) => { log('close', code, 'pongs', got, 'stdout', JSON.stringify(out.trim()), 'stderr', JSON.stringify(err.trim())); killTest(); });
function killTest() {
	const c = process.platform === 'win32' ? cp.spawn(process.execPath, ['-e', "import('qjs:os').then(o => o.sleep(30000))"]) : cp.spawn('sleep', ['30']);
	c.on('exit', (code, sig) => { log('killed sleep: exit', code, sig, 'killed flag', c.killed); const bad = cp.spawn('definitely-not-a-program'); bad.on('error', e => log('spawn error', e.code, e.syscall)); bad.on('close', c2 => log('bad close', c2)); });
	setTimeout(() => c.kill('SIGTERM'), 100);
}
