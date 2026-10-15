// Streams over file descriptors, driven by QuickJS's event loop (qjs:os setReadHandler / setWriteHandler) with O_NONBLOCK fds.
// Internal helper (not a Node module): used by child_process (stdio pipes, IPC channel) and net (sockets).
import * as os from 'qjs:os';
import * as p from 'spike:proc';
import * as io from './fdio.js';
import { Readable, Writable, Duplex } from './stream.js';

const BUFSZ = 65536, EAGAIN = -11, EINTR = -4;
p.ignoreSigpipe();
export const errnoError = (neg, syscall, extra) => { const code = p.errname(neg); return Object.assign(new Error(`${syscall} ${code}`), { errno: neg, code, syscall, ...extra }); };

// ---- shared read/write machinery (mixed into the three stream classes) --------------------------------------------------------------------
function startReading(s) {
	if (s._reading || s._fd < 0) { return; }
	s._reading = true;
	io.setReadHandler(s._fd, () => {
		const n = io.read(s._fd, s._rbuf ??= new ArrayBuffer(BUFSZ), 0, BUFSZ);
		if (n === EAGAIN || n === EINTR) { return; }
		if (n <= 0) { stopReading(s); if (n < 0 && n !== -104 /*ECONNRESET*/ && n !== -5 /*EIO*/) { s.destroy(errnoError(n, 'read')); } else { s.push(null); } return; }
		if (!s.push(Buffer.from(new Uint8Array(s._rbuf, 0, n)))) { stopReading(s); }
	});
}
function stopReading(s) { if (s._reading) { s._reading = false; if (s._fd >= 0) { io.setReadHandler(s._fd, null); } } }
function writeChunk(s, chunk, enc, cb) {
	const data = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk;
	let off = 0;
	const step = () => {
		while (off < data.length) {
			const n = io.write(s._fd, data.buffer, data.byteOffset + off, data.length - off);
			if (n === EAGAIN || n === EINTR) { io.setWriteHandler(s._fd, () => { io.setWriteHandler(s._fd, null); step(); }); return; }
			if (n < 0) { cb(errnoError(n, 'write')); return; }
			off += n;
		}
		cb();
	};
	if (s._fd < 0) { cb(Object.assign(new Error('write after the descriptor was closed'), { code: 'ERR_STREAM_DESTROYED' })); return; }
	step();
}
function closeFd(s) { if (s._fd >= 0) { stopReading(s); io.setWriteHandler(s._fd, null); io.close(s._fd); s._fd = -1; } }

/** Read side of a pipe (child's stdout/stderr). */
export class FdReadable extends Readable {
	constructor(fd, opts = {}) { super({ highWaterMark: BUFSZ, emitClose: true }); this._fd = fd; this._reading = false; if (opts.nonblock !== false) { p.setNonblock(fd, true); } this.once('end', () => this.destroy()); }
	_read() { startReading(this); }
	_destroy(err, cb) { closeFd(this); cb(err); }
	get fd() { return this._fd; }
}
/** Write side of a pipe (child's stdin). `end()` flushes then closes the fd so the peer sees EOF. */
export class FdWritable extends Writable {
	constructor(fd) { super({ highWaterMark: BUFSZ, emitClose: true, decodeStrings: false }); this._fd = fd; p.setNonblock(fd, true); }
	_write(chunk, enc, cb) { writeChunk(this, chunk, enc, cb); }
	_final(cb) { closeFd(this); cb(); }
	_destroy(err, cb) { closeFd(this); cb(err); }
	get fd() { return this._fd; }
}
/** Full-duplex endpoint on one fd (socketpair end, TCP or unix socket). `end()` half-closes the write side (shutdown); the read side then reads to EOF. */
export class FdDuplex extends Duplex {
	constructor(fd, opts = {}) { super({ highWaterMark: BUFSZ, emitClose: true, decodeStrings: false, allowHalfOpen: opts.allowHalfOpen ?? false }); this._fd = fd; this._reading = false; if (fd >= 0) { p.setNonblock(fd, true); } const done = () => { if (this._readableState.endEmitted && this._writableState.finished) { this.destroy(); } }; this.on('end', done); this.on('finish', done); }
	_read() { startReading(this); }
	_write(chunk, enc, cb) { writeChunk(this, chunk, enc, cb); }
	_final(cb) { if (this._fd >= 0) { p.shutdown(this._fd, 1 /*SHUT_WR*/); } cb(); }
	_destroy(err, cb) { closeFd(this); cb(err); }
	get fd() { return this._fd; }
	_attachFd(fd) { this._fd = fd; p.setNonblock(fd, true); if (this._readableState.flowing !== false && this.listenerCount('data') + this.listenerCount('readable') > 0) { startReading(this); } }
}
export { startReading, stopReading };
