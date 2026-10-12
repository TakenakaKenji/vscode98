// net over a Windows named pipe: server accepts two clients one after the other (and one concurrently), echoes upper-cased data, client reads it back.
const net = require('net');
const name = '\\\\.\\pipe\\qjs98-test-' + process.pid;
let fails = 0; const check = (n, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + n + ' ' + extra); if (!ok) { fails++; } };
const server = net.createServer((sock) => { sock.on('data', (d) => sock.write(String(d).toUpperCase())); sock.on('end', () => sock.end()); });
server.on('error', (e) => { console.log('server error', e.message); process.exit(2); });
server.listen(name, () => {
	const results = [];
	const talk = (label, msg, cb) => { const c = net.connect(name); let got = ''; c.on('connect', () => c.write(msg)); c.on('data', (d) => { got += d; if (got.length >= msg.length) { results.push([label, got]); c.end(); cb && cb(); } }); c.on('error', (e) => { results.push([label, 'ERR ' + e.code]); cb && cb(); }); };
	let pending = 3; const done = () => { if (--pending === 0) { check('three clients served', results.length === 3 && results.every(([l, g]) => g === 'HELLO ' + l.toUpperCase()), JSON.stringify(results)); const big = 'x'.repeat(300000); const c = net.connect(name); let n = 0; c.on('connect', () => c.write(big)); c.on('data', (d) => { n += d.length; if (n >= big.length) { check('300 KB echoed through the pipe', n === big.length, 'n=' + n); c.end(); server.close(() => { console.log(fails ? 'FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0); }); } }); } };
	talk('a', 'hello a', done); talk('b', 'hello b', done); talk('c', 'hello c', done);
	const bad = net.connect('\\\\.\\pipe\\no-such-pipe-xyz'); bad.on('error', (e) => check('connect to a missing pipe fails with ENOENT', e.code === 'ENOENT', e.code));
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 20000);
