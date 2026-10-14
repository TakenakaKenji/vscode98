// `child_process` on QuickJS: spawn / fork (with an IPC channel) / exec / execFile / spawnSync / execSync, built on spike:proc + qjs:os.
// Process exit is detected with SIGCHLD + waitpid(WNOHANG) (plus a slow safety timer that also keeps the event loop alive while children exist).
import * as os from 'qjs:os';
import * as std from 'qjs:std';
import * as p from 'spike:proc';
import * as io from './fdio.js';
import { EventEmitter } from '__SHIMS__/events.js';
import { Readable, Writable } from './stream.js';
import { FdReadable, FdWritable, FdDuplex, errnoError } from './fdstreams.js';

const TRACE = !!std.getenv('VSCODE98_TRACE_PROC');   // debug aid: log spawns, exits and child stderr to our stderr
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19 };
const SIGNAMES = Object.fromEntries(Object.entries(SIGNALS).map(([k, v]) => [v, k]));
const sigNum = (s) => s === undefined ? SIGNALS.SIGTERM : typeof s === 'number' ? s : (SIGNALS[s] ?? (() => { throw Object.assign(new TypeError(`Unknown signal: ${s}`), { code: 'ERR_UNKNOWN_SIGNAL' }); })());

// ---- exit tracking ----------------------------------------------------------------------------------------------------------------------
const live = new Map();     // pid -> ChildProcess
let keepAlive = null;
function reap() {
	for (const [pid, cp] of [...live]) {
		const r = os.waitpid(pid, os.WNOHANG);
		if (r[0] === pid || r[0] < 0) { live.delete(pid); try { cp._onExit(r[0] === pid ? r[1] : 0); } catch (e) { setTimeout(() => { throw e; }, 0); } }       // a throwing 'exit' listener must not stop the other children from being reaped
	}
	if (live.size === 0 && keepAlive !== null) { os.clearTimeout(keepAlive); keepAlive = null; }
}
const tick = () => { try { reap(); } finally { keepAlive = live.size ? os.setTimeout(tick, 500) : null; } };
if (os.platform !== 'win32') { os.signal(os.SIGCHLD, reap); }
function track(cp) {
	live.set(cp.pid, cp);
	if (os.platform === 'win32') {      // a waitable process handle in the event loop (winproc.c): no signal, no polling
		p.watchExit(cp.pid, (code, killed) => { live.delete(cp.pid); try { cp._onExitWin(code, killed); } catch (e) { setTimeout(() => { throw e; }, 0); } });
		return;
	}
	if (keepAlive === null) { keepAlive = os.setTimeout(tick, 500); }
}

// ---- ChildProcess -----------------------------------------------------------------------------------------------------------------------
export class ChildProcess extends EventEmitter {
	constructor() { super(); this.pid = undefined; this.stdin = this.stdout = this.stderr = null; this.stdio = []; this.connected = false; this.killed = false; this.exitCode = null; this.signalCode = null; this.spawnfile = undefined; this.spawnargs = []; this.channel = undefined; this._pendingClose = 0; this._exited = false; }
	kill(sig) { const n = sigNum(sig); if (this.pid === undefined || this._exited) { return false; } const r = os.platform === 'win32' ? p.kill(this.pid, n) : os.kill(this.pid, n); if (r === 0 || r === undefined) { this.killed = true; return true; } return false; }
	ref() { } unref() { }
	send(message, handle, options, callback) {
		if (typeof handle === 'function') { callback = handle; handle = undefined; } else if (typeof options === 'function') { callback = options; }
		if (!this.connected) { const e = Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }); if (typeof callback === 'function') { queueMicrotask(() => callback(e)); } else { queueMicrotask(() => this.emit('error', e)); } return false; }
		return this._chan.write(JSON.stringify(message) + '\n', 'utf8', typeof callback === 'function' ? (e) => callback(e || null) : undefined);
	}
	disconnect() { if (!this.connected) { queueMicrotask(() => this.emit('error', Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }))); return; } this._chan.destroy(); }
	_attachChannel(chan) {
		this._chan = chan; this.channel = chan; this.connected = true; let acc = '';
		chan.setEncoding?.('utf8'); chan.on('data', (d) => { acc += typeof d === 'string' ? d : d.toString('utf8'); let i; while ((i = acc.indexOf('\n')) >= 0) { const line = acc.slice(0, i); acc = acc.slice(i + 1); if (!line) { continue; } let m; try { m = JSON.parse(line); } catch { continue; } if (m && typeof m.cmd === 'string' && m.cmd.startsWith('NODE_')) { continue; } this.emit('message', m); } });
		chan.on('error', () => { });
		chan.on('close', () => { if (this.connected) { this.connected = false; this.channel = undefined; this.emit('disconnect'); this._streamClosed(); } });
		this._pendingClose++;
	}
	_streamClosed() { if (--this._pendingClose <= 0) { this._maybeClose(); } }
	_maybeClose() { if (this._exited && this._pendingClose <= 0 && !this._closeEmitted) { this._closeEmitted = true; this.emit('close', this.exitCode, this.signalCode); } }
	_onExitWin(code, killed) {          // Windows: the exit code is the raw 32-bit value; a process we terminated reports SIGTERM like Node does
		this._exited = true;
		if (killed) { this.exitCode = null; this.signalCode = 'SIGTERM'; } else { this.exitCode = code; this.signalCode = null; }
		this.emit('exit', this.exitCode, this.signalCode);
		if (this.stdin && !this.stdin.destroyed) { this.stdin.destroy(); }
		for (const s of [this.stdout, this.stderr]) { if (s && s.readable && !s.destroyed) { s.resume(); } }
		this._maybeClose();
	}
	_onExit(status) {
		this._exited = true;
		if ((status & 0x7f) === 0) { this.exitCode = (status >> 8) & 0xff; } else { this.signalCode = SIGNAMES[status & 0x7f] || 'SIGUNKNOWN'; }
		this.emit('exit', this.exitCode, this.signalCode);
		if (this.stdin && !this.stdin.destroyed) { this.stdin.destroy(); }      // like Node: the write side dies with the process
		for (const s of [this.stdout, this.stderr]) { if (s && s.readable && !s.destroyed) { s.resume(); } }     // Node's flushStdio: unread output must not block 'close'
		this._maybeClose();
	}
}
const watch = (cp, s) => { if (s) { cp._pendingClose++; s.on('close', () => cp._streamClosed()); } };

// ---- shell: /bin/sh -c on POSIX, %ComSpec% /d /s /c "line" on Windows (verbatim arguments, as Node does) ----
const WINDOWS = os.platform === 'win32';
function shellInvocation(shell, line) {
	if (WINDOWS) { const file = typeof shell === 'string' ? shell : (std.getenv('ComSpec') || 'cmd.exe'); return { file, args: ['/d', '/s', '/c', `"${line}"`], verbatim: /(^|[\\/])cmd(\.exe)?$/i.test(file) }; }
	return { file: typeof shell === 'string' ? shell : '/bin/sh', args: ['-c', line], verbatim: false };
}
// ---- spawn ------------------------------------------------------------------------------------------------------------------------------
function envList(env) {
	if (!env) { return Object.entries(std.getenviron()).map(([k, v]) => `${k}=${v}`); }
	return Object.keys(env).filter(k => env[k] !== undefined).map(k => `${k}=${env[k]}`);
}
function normStdio(stdio, forkIpc) {
	let a = stdio === undefined ? ['pipe', 'pipe', 'pipe'] : typeof stdio === 'string' ? [stdio, stdio, stdio] : [...stdio];
	while (a.length < 3) { a.push('pipe'); }
	return a.map(x => x === undefined || x === null ? 'pipe' : x);
}
export function spawn(command, args, options) {
	if (!Array.isArray(args)) { options = args; args = []; }
	options = { ...options };
	let file = options.file ?? command, argv0 = options.argv0 ?? file;
	let argList = [...args];
	let verbatim = !!options.windowsVerbatimArguments;
	if (options.shell) { const sh = shellInvocation(options.shell, [command, ...args].join(' ')); file = sh.file; argList = sh.args; argv0 = file; verbatim = sh.verbatim; }
	const cp = new ChildProcess(); cp.spawnfile = file; cp.spawnargs = [argv0, ...argList];
	const stdio = normStdio(options.stdio), n = stdio.length;
	const childFds = new Array(n).fill(-1), parentEnds = new Array(n).fill(-1), toClose = [];
	let ipcIndex = -1;
	for (let i = 0; i < n; i++) {
		const s = stdio[i];
		if (s === 'pipe') { const [r, w] = p.pipe(i === 0 ? 0 : 1); if (i === 0) { childFds[i] = r; parentEnds[i] = w; toClose.push(r); } else { childFds[i] = w; parentEnds[i] = r; toClose.push(w); } }
		else if (s === 'ipc') { const [a, b] = p.socketpair(); childFds[i] = a; parentEnds[i] = b; toClose.push(a); ipcIndex = i; }
		else if (s === 'inherit') { childFds[i] = i; }
		else if (s === 'ignore') { childFds[i] = -1; }
		else if (typeof s === 'number') { childFds[i] = s; }
		else if (s && typeof s.fd === 'number') { childFds[i] = s.fd; }
	}
	const env = envList(options.env); if (ipcIndex >= 0) { env.push(`NODE_CHANNEL_FD=${ipcIndex}`, 'NODE_CHANNEL_SERIALIZATION_MODE=json'); }
	const pid = p.spawn({ file, args: [argv0, ...argList], env, cwd: options.cwd, fds: childFds, detached: !!options.detached, verbatim });
	for (const fd of toClose) { io.close(fd); }
	if (pid < 0) {
		for (const fd of parentEnds) { if (fd >= 0) { io.close(fd); } }
		const err = errnoError(pid, `spawn ${file}`, { path: file, spawnargs: argList });
		// as in Node, the stdio streams of a process that could not start exist (and are destroyed): callers attach handlers to child.stdout before the 'error' event arrives
		for (let i = 0; i < n; i++) { if (stdio[i] !== 'pipe') { cp.stdio.push(null); continue; } const s = i === 0 ? new Writable({ write(c, e, cb) { cb(); } }) : new Readable({ read() { } }); queueMicrotask(() => s.destroy()); cp.stdio.push(s); if (i === 0) { cp.stdin = s; } else if (i === 1) { cp.stdout = s; } else if (i === 2) { cp.stderr = s; } }
		cp.exitCode = pid; queueMicrotask(() => { cp.emit('error', err); cp._exited = true; cp._maybeClose(); });
		return cp;
	}
	cp.pid = pid;
	for (let i = 0; i < n; i++) {
		const fd = parentEnds[i]; if (fd < 0) { cp.stdio.push(null); continue; }
		let s;
		if (stdio[i] === 'ipc') { s = null; cp._attachChannel(new FdDuplex(fd)); }
		else if (i === 0) { s = new FdWritable(fd); watch(cp, s); } else { s = new FdReadable(fd); watch(cp, s); }
		cp.stdio.push(s);
		if (i === 0) { cp.stdin = s; } else if (i === 1) { cp.stdout = s; } else if (i === 2) { cp.stderr = s; }
	}
	track(cp);
	if (TRACE) { std.err.puts(`[proc] spawn pid=${pid} ${file} ${JSON.stringify(argList).slice(0, 300)}\n`); cp.on('exit', (c, sg) => std.err.puts(`[proc] exit pid=${pid} code=${c} signal=${sg}\n`)); cp.stderr?.on('data', d => std.err.puts(`[proc] pid=${pid} stderr: ${d}`)); }
	queueMicrotask(() => cp.emit('spawn'));
	return cp;
}
const HOST_ARGS = () => globalThis.__forkHostArgs || [];
export function fork(modulePath, args, options) {
	if (!Array.isArray(args)) { options = args; args = []; }
	options = { ...options };
	const execPath = options.execPath || process.execPath;
	let execArgv = options.execArgv || process.execArgv || [];
	const isHost = execPath === process.execPath;
	if (isHost) { execArgv = execArgv.filter(a => !String(a).startsWith('--')); }       // V8 flags (--max-old-space-size, --inspect...) mean nothing to the QuickJS host
	let stdio = options.stdio;
	if (stdio === undefined) { stdio = options.silent ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc']; }
	else if (typeof stdio === 'string') { stdio = [stdio, stdio, stdio, 'ipc']; }
	else if (!stdio.includes('ipc')) { stdio = [...stdio, 'ipc']; }
	return spawn(execPath, [...(isHost ? HOST_ARGS() : []), ...execArgv, modulePath, ...args], { ...options, stdio });
}

// ---- exec / execFile -------------------------------------------------------------------------------------------------------------------
function collect(child, options, callback, cmdLabel) {
	const enc = options.encoding === undefined ? 'utf8' : options.encoding, max = options.maxBuffer ?? 1024 * 1024;
	const out = [], err = []; let outN = 0, errN = 0, killedBy = null, done = false, timer = null, exitCode = null, exitSignal = null, closed = false;
	const text = (chunks) => { const b = Buffer.concat(chunks.map(c => typeof c === 'string' ? Buffer.from(c) : c)); return enc === 'buffer' || enc === null ? b : b.toString(enc === 'utf8' || enc === 'utf-8' ? 'utf8' : enc); };
	const finish = (error) => {
		if (done) { return; } done = true; if (timer) { os.clearTimeout(timer); }
		const so = text(out), se = text(err);
		let e = error;
		if (!e && (exitCode !== 0 || exitSignal)) { e = Object.assign(new Error(`Command failed: ${cmdLabel}\n${enc === 'buffer' ? se.toString() : se}`), { code: exitCode ?? undefined }); }
		if (e) { e.killed = child.killed || killedBy !== null; e.signal = exitSignal; e.cmd = cmdLabel; if (e.code === undefined) { e.code = exitCode; } }
		if (callback) { callback(e || null, so, se); }
	};
	const add = (arr, which) => (d) => { const len = d.length; if (which === 'o') { outN += len; } else { errN += len; } arr.push(d); if ((outN > max || errN > max) && !killedBy) { killedBy = 'maxBuffer'; child.kill(); finish(Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })); } };
	child.stdout?.on('data', add(out, 'o')); child.stderr?.on('data', add(err, 'e'));
	child.on('error', (e) => finish(e));
	child.on('exit', (c, s) => { exitCode = c; exitSignal = s; });
	child.on('close', () => { closed = true; finish(null); });
	if (options.timeout > 0) { timer = os.setTimeout(() => { killedBy = 'timeout'; child.kill(options.killSignal || 'SIGTERM'); }, options.timeout); }
	return child;
}
export function execFile(file, args, options, callback) {
	if (typeof args === 'function') { callback = args; args = []; options = {}; } else if (!Array.isArray(args)) { callback = typeof options === 'function' ? options : callback; options = args || {}; args = []; } else if (typeof options === 'function') { callback = options; options = {}; }
	options = { ...options };
	const child = spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
	return collect(child, options, callback, [file, ...args].join(' '));
}
export function exec(command, options, callback) {
	if (typeof options === 'function') { callback = options; options = {}; }
	options = { ...options, shell: options?.shell || true };
	const child = spawn(command, [], { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
	return collect(child, options, callback, command);
}
const custom = Symbol.for('nodejs.util.promisify.custom');
const promisified = (fn) => (...a) => new Promise((res, rej) => { const c = fn(...a, (err, stdout, stderr) => err ? rej(Object.assign(err, { stdout, stderr })) : res({ stdout, stderr })); });
Object.defineProperty(exec, custom, { value: promisified(exec) }); Object.defineProperty(execFile, custom, { value: promisified(execFile) });

// ---- synchronous variants -----------------------------------------------------------------------------------------------------------------
export function spawnSync(command, args, options) {
	if (!Array.isArray(args)) { options = args; args = []; }
	options = { ...options };
	let file = command, argList = [...args];
	let verbatim = !!options.windowsVerbatimArguments;
	if (options.shell) { const sh = shellInvocation(options.shell, [command, ...args].join(' ')); file = sh.file; argList = sh.args; verbatim = sh.verbatim; }
	const spec = typeof options.stdio === 'string' ? [options.stdio, options.stdio, options.stdio] : (options.stdio || ['pipe', 'pipe', 'pipe']);
	const fds = [-1, -1, -1], mine = [-1, -1, -1], closeAfter = [];
	for (let i = 0; i < 3; i++) {
		const s = spec[i] ?? 'pipe';
		if (s === 'pipe') { const [r, w] = p.pipe(i === 0 ? 0 : 1); if (i === 0) { fds[i] = r; mine[i] = w; closeAfter.push(r); } else { fds[i] = w; mine[i] = r; closeAfter.push(w); } }
		else if (s === 'inherit') { fds[i] = i; } else if (typeof s === 'number') { fds[i] = s; }
	}
	const pid = p.spawn({ file, args: [file, ...argList], env: envList(options.env), cwd: options.cwd, fds, verbatim });
	for (const fd of closeAfter) { io.close(fd); }
	if (pid < 0) { for (const fd of mine) { if (fd >= 0) { io.close(fd); } } return { pid: 0, output: null, stdout: null, stderr: null, status: null, signal: null, error: errnoError(pid, `spawnSync ${file}`, { path: file, spawnargs: argList }) }; }
	let input = options.input; if (typeof input === 'string') { input = Buffer.from(input); } if (input && input.buffer) { input = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength); }
	const r = p.pollSync({ pid, inFd: mine[0], input, outFd: mine[1], errFd: mine[2], timeoutMs: options.timeout || 0, maxBuffer: options.maxBuffer ?? 1024 * 1024 });
	const enc = options.encoding && options.encoding !== 'buffer' ? options.encoding : null;
	const conv = (ab, used) => used ? (enc ? Buffer.from(new Uint8Array(ab)).toString(enc) : Buffer.from(new Uint8Array(ab))) : null;
	const stdout = conv(r.out, spec[1] !== 'inherit' && spec[1] !== 'ignore'), stderr = conv(r.err, spec[2] !== 'inherit' && spec[2] !== 'ignore');
	const res = { pid, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: r.signal === null ? null : (SIGNAMES[r.signal] || 'SIGUNKNOWN') };
	if (r.timedOut) { res.error = Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), { code: 'ETIMEDOUT', errno: -110, syscall: `spawnSync ${file}`, path: file }); }
	else if (r.overflow) { res.error = Object.assign(new Error(`spawnSync ${file} ENOBUFS`), { code: 'ENOBUFS' }); }
	return res;
}
export function execFileSync(file, args, options) {
	if (!Array.isArray(args)) { options = args; args = []; }
	const o = { ...options }; if (o.stdio === undefined) { o.stdio = ['pipe', 'pipe', 'inherit']; }
	const r = spawnSync(file, args, o);
	if (r.error) { throw r.error; }
	if (r.status !== 0) { const e = new Error(`Command failed: ${[file, ...args].join(' ')}${r.stderr ? '\n' + r.stderr : ''}`); Object.assign(e, { status: r.status, signal: r.signal, output: r.output, pid: r.pid, stdout: r.stdout, stderr: r.stderr }); throw e; }
	return r.stdout;
}
export function execSync(command, options) { const sh = shellInvocation(true, command); return execFileSync(sh.file, sh.args, { ...options, windowsVerbatimArguments: sh.verbatim }); }

export default { ChildProcess, spawn, fork, exec, execFile, spawnSync, execFileSync, execSync };
