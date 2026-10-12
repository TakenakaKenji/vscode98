// The "node" of this spike: runs a script on QuickJS with the Node shims, as a forked child would run under real Node.
//   qjs-spike5 --stack-size 0 fork_main.mjs <shimsOutDir> <script.js|.mjs> [args...]
// Provides: process.argv/execPath/execArgv, process.stdin/stdout/stderr as real fd streams, the IPC channel (process.send / 'message' / 'disconnect') when
// NODE_CHANNEL_FD is set, a real process.kill, and CommonJS execution of the script through the shim's Module loader. Forked grandchildren re-enter here.
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import '../../02-node-shim/host/globals.js';

// NOTE: no top-level await (see spike 2: with TLA `qjs` only runs one job per poll and microtasks stall until the next timer fires).
async function boot() {
const [outDir, script, ...rest] = scriptArgs.slice(1);
const here = scriptArgs[0];
globalThis.__forkHostArgs = ['--stack-size', '0', here.startsWith('/') ? here : os.getcwd()[0] + '/' + here, outDir];
std.setenv('VSCODE_WILL_SEND_MESSAGE_PORT', '1');
if (std.getenv('NLS_MESSAGES')) { globalThis._VSCODE_NLS_MESSAGES = JSON.parse(std.loadFile(std.getenv('NLS_MESSAGES'))); globalThis._VSCODE_NLS_LANGUAGE = 'en'; }

// ---- preload every Node builtin shim into the table the CommonJS loader reads
globalThis.__builtins ??= {};
for (const f of os.readdir(outDir + '/shims')[0].filter(f => f.endsWith('.js'))) {
	const name = f.slice(0, -3).replace(/__/g, '/');
	try { const ns = await import(`${outDir}/shims/${f}`); globalThis.__builtins[name] = ns.default ?? ns; } catch (e) { std.err.puts(`preload failed ${name}: ${e.message}\n`); }
}
const { Writable } = await import(`${outDir}/shims/stream.js`);
const { FdReadable, FdDuplex } = await import(`${outDir}.impl/fdstreams.js`);
const p = await import('spike:proc');
const events = globalThis.__builtins.events;

// ---- process
const P = globalThis.process;
const exePath = os.exePath ? os.exePath() : '/proc/self/exe';
P.execPath = (std.getenv('VSCODE98_HOST') || exePath); P.execArgv = []; P.pid = os.getpid(); P.ppid = 1;
P.argv = [P.execPath, script.startsWith('/') ? script : os.getcwd()[0] + '/' + script, ...rest];
P.kill = (pid, sig = 'SIGTERM') => { const n = typeof sig === 'number' ? sig : ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1, SIGUSR1: 10, SIGUSR2: 12 })[sig] ?? 15; const r = os.kill(pid, n); if (r < 0) { throw Object.assign(new Error(`kill ESRCH`), { code: 'ESRCH', errno: -3, syscall: 'kill' }); } return true; };
class SyncFd extends Writable {          // like Node's stdout for pipes/files on POSIX: synchronous
	constructor(fd, flush) { super({ decodeStrings: false }); this.fd = fd; this._flush = flush; this.isTTY = os.isatty(fd); }
	_write(chunk, enc, cb) { const b = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk; this._flush(); let off = 0; while (off < b.length) { const n = os.write(this.fd, b.buffer, b.byteOffset + off, b.length - off); if (n === -11) { os.sleep(1); continue; } if (n < 0) { cb(new Error('write error ' + n)); return; } off += n; } cb(); }
}
P.stdout = new SyncFd(1, () => std.out.flush()); P.stderr = new SyncFd(2, () => std.err.flush());
let stdin; Object.defineProperty(P, 'stdin', { get() { return stdin ??= Object.assign(new FdReadable(0, { nonblock: false }), { isTTY: os.isatty(0), fd: 0 }); }, configurable: true });
// QuickJS's console has only `log` (buffered stdio); give it Node's behaviour: log/info/debug -> stdout, error/warn/trace -> stderr, unbuffered and in order.
const fmt = globalThis.__builtins.util.format;
for (const m of ['log', 'info', 'debug']) { console[m] = (...a) => { std.out.puts(fmt(...a) + '\n'); std.out.flush(); }; }
for (const m of ['error', 'warn', 'trace']) { console[m] = (...a) => { std.out.flush(); std.err.puts(fmt(...a) + '\n'); std.err.flush(); }; }
const realExit = P.exit; let exiting = false;
P.exit = (c) => { if (!exiting) { exiting = true; try { P.emit('exit', c ?? P.exitCode ?? 0); } catch (e) { /* ignore */ } } std.out.flush(); std.err.flush(); std.exit(c ?? P.exitCode ?? 0); };

// ---- IPC channel (child side): JSON lines on the inherited socketpair end
const chanFd = std.getenv('NODE_CHANNEL_FD');
if (chanFd !== undefined) {
	const fd = Number(chanFd); std.unsetenv('NODE_CHANNEL_FD'); std.unsetenv('NODE_CHANNEL_SERIALIZATION_MODE');
	const chan = new FdDuplex(fd); P.channel = chan; P.connected = true; let acc = '';
	chan.setEncoding('utf8');
	chan.on('data', (d) => { acc += d; let i; while ((i = acc.indexOf('\n')) >= 0) { const line = acc.slice(0, i); acc = acc.slice(i + 1); if (!line) { continue; } let m; try { m = JSON.parse(line); } catch { continue; } if (m && typeof m.cmd === 'string' && m.cmd.startsWith('NODE_')) { continue; } P.emit('message', m); } });
	chan.on('error', () => { });
	chan.on('close', () => { if (P.connected) { P.connected = false; P.channel = undefined; P.emit('disconnect'); } });
	P.send = (msg, handle, opts, cb) => { if (typeof handle === 'function') { cb = handle; } else if (typeof opts === 'function') { cb = opts; } if (!P.connected) { const e = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }); if (cb) { queueMicrotask(() => cb(e)); } else { queueMicrotask(() => P.emit('error', e)); } return false; } return chan.write(JSON.stringify(msg) + '\n', 'utf8', cb ? (e) => cb(e || null) : undefined); };
	P.disconnect = () => { if (P.connected) { chan.destroy(); } };
	if (chan.resume) { chan.resume(); }
}

// ---- run the script
const Module = globalThis.__builtins.module;
async function main() {
	try {
		if (script.endsWith('.mjs')) { await import(P.argv[1]); } else { Module._load(P.argv[1], null, true); }
	} catch (e) { std.err.puts(`fork_main: uncaught ${e && e.stack || e}\n`); std.err.flush(); P.exit(1); }
}
main();
}
boot();
