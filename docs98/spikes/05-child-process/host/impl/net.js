// `net` on QuickJS: TCP and unix-domain-socket clients/servers on non-blocking fds (spike:proc) + the event loop (qjs:os). IPv4/IPv6 via getaddrinfo (blocking).
import * as os from 'qjs:os';
import * as p from 'spike:proc';
import { EventEmitter } from '__SHIMS__/events.js';
import { FdDuplex, errnoError } from './fdstreams.js';

const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
export const isIPv4 = (s) => ipv4.test(String(s));
export const isIPv6 = (s) => /^[0-9a-fA-F:.]+$/.test(String(s)) && String(s).includes(':') && String(s).split(':').length <= 9;
export const isIP = (s) => isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0;

export class Socket extends FdDuplex {
	constructor(options = {}) {
		super(options.fd ?? -1, options);
		this.connecting = false; this.remoteAddress = undefined; this.remotePort = undefined; this.remoteFamily = undefined; this.localAddress = undefined; this.localPort = undefined; this.bytesRead = 0; this._connectWaiters = [];
		if (options.fd !== undefined && options.fd >= 0) { this.remoteAddress = options.remoteAddress; }
	}
	connect(...args) {
		let { options, cb } = normalizeArgs(args); if (cb) { this.once('connect', cb); }
		this.connecting = true;
		const r = options.path ? p.connectUnix(options.path) : p.connect(options.host || 'localhost', options.port);
		const pathLike = options.path ? options.path : `${options.host || 'localhost'}:${options.port}`;
		if (typeof r === 'number') { queueMicrotask(() => this._fail(errnoError(r, 'connect', options.path ? { address: options.path } : { address: options.host || 'localhost', port: options.port }))); return this; }
		this._attachFd(r.fd); this.remoteAddress = options.path ?? (options.host || 'localhost'); this.remotePort = options.port;
		os.setWriteHandler(r.fd, () => {
			os.setWriteHandler(r.fd, null);
			const e = p.soError(r.fd);
			if (e < 0) { this._fail(errnoError(e, 'connect', options.path ? { address: options.path } : { address: options.host || 'localhost', port: options.port })); return; }
			this.connecting = false; this.localPort = p.sockPort(r.fd); this.emit('connect'); this.emit('ready');
			for (const w of this._connectWaiters.splice(0)) { w(); }
			this._startIfFlowing();
		});
		return this;
	}
	_startIfFlowing() { if (this._readableState.flowing || this._readableState.length === 0 && this._readableState.pipesCount) { this._read(); } else if (this.listenerCount('data') + this.listenerCount('readable')) { this._read(); } }
	_fail(err) { this.connecting = false; this.destroy(err); }
	_write(chunk, enc, cb) { if (this.connecting) { this._connectWaiters.push(() => super._write(chunk, enc, cb)); } else { super._write(chunk, enc, cb); } }
	_read(n) { if (!this.connecting) { super._read(n); } else { this._connectWaiters.push(() => super._read(n)); } }
	address() { return { port: this.localPort, family: 'IPv4', address: this.localAddress || '127.0.0.1' }; }
	setNoDelay() { return this; } setKeepAlive() { return this; } setTimeout(ms, cb) { if (cb) { this.once('timeout', cb); } return this; } ref() { return this; } unref() { return this; }
	get readyState() { return this.connecting ? 'opening' : this.destroyed ? 'closed' : 'open'; }
}
function normalizeArgs(args) {
	let options = {}, cb;
	if (typeof args[args.length - 1] === 'function') { cb = args.pop(); }
	const a0 = args[0];
	if (a0 !== null && typeof a0 === 'object') { options = { ...a0 }; if (options.path === undefined && options.port !== undefined) { options.port = Number(options.port); } }
	else if (typeof a0 === 'string' && isNaN(Number(a0))) { options = { path: a0 }; }
	else { options = { port: Number(a0) }; if (typeof args[1] === 'string') { options.host = args[1]; } }
	return { options, cb };
}
export function connect(...args) { const { options, cb } = normalizeArgs(args); const s = new Socket(options); return s.connect(options, cb); }
export const createConnection = connect;

export class Server extends EventEmitter {
	constructor(options, listener) { super(); if (typeof options === 'function') { listener = options; options = {}; } this._opts = options || {}; this._fd = -1; this._conns = new Set(); this.listening = false; this._path = undefined; this._addr = null; if (listener) { this.on('connection', listener); } }
	listen(...args) {
		const { options, cb } = normalizeArgs(args); if (cb) { this.once('listening', cb); }
		if (options.port === undefined && options.path === undefined) { options.port = 0; }
		const r = options.path !== undefined ? p.listenUnix(options.path) : p.listen(options.host ?? null, options.port);
		if (typeof r === 'number') { const e = errnoError(r, 'listen', options.path ? { address: options.path } : { address: options.host, port: options.port }); queueMicrotask(() => this.emit('error', e)); return this; }
		this._fd = r.fd; this._path = options.path; this.listening = true;
		this._addr = options.path !== undefined ? options.path : { address: options.host || '::', family: options.host && isIPv4(options.host) ? 'IPv4' : 'IPv6', port: r.port };
		os.setReadHandler(this._fd, () => {
			for (;;) {
				const c = p.accept(this._fd); if (c < 0) { return; }
				const s = new Socket({ fd: c, allowHalfOpen: this._opts.allowHalfOpen }); s.remoteAddress = this._path ?? '127.0.0.1';
				this._conns.add(s); s.on('close', () => { this._conns.delete(s); this._maybeClosed(); });
				this.emit('connection', s);
			}
		});
		queueMicrotask(() => this.emit('listening'));
		return this;
	}
	address() { return this._addr; }
	getConnections(cb) { cb(null, this._conns.size); }
	close(cb) {
		if (cb) { this.once('close', cb); }
		if (this._fd >= 0) { os.setReadHandler(this._fd, null); os.close(this._fd); this._fd = -1; this.listening = false; if (this._path) { try { os.remove(this._path); } catch { /* already gone */ } } }
		this._closing = true; queueMicrotask(() => this._maybeClosed()); return this;
	}
	_maybeClosed() { if (this._closing && this._conns.size === 0 && !this._closeEmitted) { this._closeEmitted = true; this.emit('close'); } }
	ref() { return this; } unref() { return this; }
}
export function createServer(options, listener) { return new Server(options, listener); }
export default { Socket, Server, connect, createConnection, createServer, isIP, isIPv4, isIPv6 };
