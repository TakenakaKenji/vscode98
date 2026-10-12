// net on QuickJS: TCP server+client in one process, unix-domain socket, a forked client talking to our server, and (optional) a real Node peer.
//   PEER=node  -> additionally spawns `node peer.js <port>` (a Node.js TCP client) against our QuickJS server.
const net = require('net'), cp = require('child_process'), path = require('path'), os = require('os');
const t0 = Date.now(); const log = (...a) => console.log(String(Date.now() - t0).padStart(5), ...a);
let pending = 0; const done = () => { if (--pending === 0) { log('ALL DONE'); setTimeout(() => process.exit(0), 50); } };
function echoServer(listenArg, label, cb) {
	const srv = net.createServer((sock) => { log(label, 'server: connection'); let n = 0; sock.on('data', d => { n += d.length; sock.write(d); }); sock.on('end', () => { log(label, 'server: client ended after', n, 'bytes'); sock.end(); }); });
	srv.on('error', e => log(label, 'server error', e.code));
	srv.listen(...listenArg, () => cb(srv));
	return srv;
}
// 1. TCP loopback echo of 3 MB
pending++;
echoServer([0, '127.0.0.1'], 'tcp', (srv) => {
	const port = srv.address().port; log('tcp: listening on', port, JSON.stringify(srv.address()));
	const payload = Buffer.alloc(3 * 1024 * 1024, 'abcdefghij'); let got = 0;
	const c = net.connect(port, '127.0.0.1', () => { log('tcp: connected'); c.write(payload); c.end(); });
	c.on('data', d => { got += d.length; }); c.on('end', () => { log('tcp: echoed', got, got === payload.length ? 'OK' : 'MISMATCH'); tcpDone(); });
	let tcpClients = 2 + (process.env.PEER === 'node' ? 1 : 0); const tcpDone = () => { if (--tcpClients === 0) { srv.close(() => { log('tcp: server closed'); done(); }); } };
	c.on('error', e => log('tcp client error', e.code));
	// 2. connection refused
	pending++; const bad = net.connect(1, '127.0.0.1'); bad.on('error', e => { log('refused:', e.code, e.syscall, e.address + ':' + e.port); done(); });
	// 4. a forked QuickJS child connects to the same server as a client
	pending++; const kid = cp.fork(path.join(__dirname, 'net_child.cjs'), [String(port)], { silent: true }); let ko = ''; kid.stdout.on('data', d => ko += d); kid.on('close', (code) => { log('forked client exit', code, JSON.stringify(ko.trim())); tcpDone(); done(); });
	// 5. optional real-Node peer
	if (process.env.PEER === 'node') { pending++; const peer = cp.spawn('node', [path.join(__dirname, 'net_peer.cjs'), String(port)]); let po = ''; peer.stdout.on('data', d => po += d); peer.on('close', (code) => { log('node peer exit', code, JSON.stringify(po.trim())); tcpDone(); done(); }); }
});
// 3. unix domain socket
pending++;
const sockPath = path.join(os.tmpdir(), 'spike5-' + process.pid + '.sock');
echoServer([sockPath], 'unix', (srv) => {
	const c = net.connect(sockPath, () => c.end('hello over unix\n')); let got = '';
	c.on('data', d => got += d); c.on('end', () => { log('unix: echoed', JSON.stringify(got)); srv.close(() => { log('unix: server closed'); done(); }); });
});
