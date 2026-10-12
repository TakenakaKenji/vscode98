// `fs` shim for the spike, on qjs:os / qjs:std. Covers the functions the process trace measured (sync + callback + promises); no streams, no watch.
// Notes for a real implementation: no fs.watch/watchFile here (needs ReadDirectoryChangesW etc.), no file descriptors beyond os.open fds, no Buffer I/O beyond a tiny shim.
import * as os from 'qjs:os';
import * as std from 'qjs:std';

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
const E = std.Error;   // errno constants live on std.Error in QuickJS (E.ENOENT etc. do not exist)
const CODES = { [E.ENOENT]: 'ENOENT', [E.EEXIST]: 'EEXIST', [E.ENOTDIR]: 'ENOTDIR', [E.EACCES]: 'EACCES', [E.EISDIR]: 'EISDIR', [E.EINVAL]: 'EINVAL', [E.EBADF]: 'EBADF', [E.ENOTEMPTY]: 'ENOTEMPTY', [E.EPERM]: 'EPERM' };
function fail(errno, syscall, path) { if (globalThis.__fsDebug) { std.err.puts(`FSFAIL ${CODES[-errno] || CODES[errno] || errno} ${syscall} ${path}\n`); } const e = new Error(`${CODES[-errno] || CODES[errno] || 'E' + errno}: ${syscall} '${path}'`); e.errno = -Math.abs(errno); e.code = CODES[Math.abs(errno)] || 'EUNKNOWN'; e.syscall = syscall; e.path = path; return e; }

export class Stats {
	constructor(o) { Object.assign(this, { dev: o.dev, ino: o.ino, mode: o.mode, nlink: o.nlink, uid: o.uid, gid: o.gid, rdev: o.rdev, size: o.size, atimeMs: o.atime, mtimeMs: o.mtime, ctimeMs: o.ctime, mtime: new Date(o.mtime), atime: new Date(o.atime), ctime: new Date(o.ctime), birthtime: new Date(o.ctime), birthtimeMs: o.ctime }); }
	isFile() { return (this.mode & S_IFMT) === S_IFREG; } isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; } isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
	isFIFO() { return false; } isSocket() { return false; } isBlockDevice() { return false; } isCharacterDevice() { return false; }
}
export class Dirent {
	constructor(name, mode, parent) { this.name = name; this.parentPath = parent; this.path = parent; this._m = mode; }
	isFile() { return (this._m & S_IFMT) === S_IFREG; } isDirectory() { return (this._m & S_IFMT) === S_IFDIR; } isSymbolicLink() { return (this._m & S_IFMT) === S_IFLNK; }
}
export class Buf extends Uint8Array {   // tiny Buffer stand-in
	toString(enc = 'utf8', s = 0, e = this.length) { return new TextDecoder().decode(this.subarray(s, e)); }
}
const toBuf = (ab, n) => new Buf(ab, 0, n);
const enc = (o) => typeof o === 'string' ? o : o && o.encoding;

export function statSync(p, opts) { const [o, e] = os.stat(String(p)); if (e) { if (opts && opts.throwIfNoEntry === false && e === E.ENOENT) { return undefined; } throw fail(e, 'stat', p); } return new Stats(o); }
export function lstatSync(p, opts) { const [o, e] = os.lstat(String(p)); if (e) { if (opts && opts.throwIfNoEntry === false && e === E.ENOENT) { return undefined; } throw fail(e, 'lstat', p); } return new Stats(o); }
export function existsSync(p) { return os.stat(String(p))[1] === 0; }
export function accessSync(p) { const e = os.stat(String(p))[1]; if (e) { throw fail(e, 'access', p); } }
export function readdirSync(p, opts) {
	const [names, e] = os.readdir(String(p)); if (e) { throw fail(e, 'scandir', p); }
	const list = names.filter(n => n !== '.' && n !== '..');
	return opts && opts.withFileTypes ? list.map(n => new Dirent(n, (os.lstat(p + '/' + n)[0] || { mode: 0 }).mode, String(p))) : list;
}
export function readFileSync(p, opts) {
	const encoding = enc(opts);
	if (typeof p === 'number') { const path = fdPaths.get(p); if (path === undefined) { throw fail(E.EBADF, 'read', p); } p = path; }   // an fd instead of a path
	if (encoding) { const s = std.loadFile(String(p)); if (s === null) { throw fail(E.ENOENT, 'open', p); } return s; }
	const f = std.open(String(p), 'rb'); if (!f) { throw fail(E.ENOENT, 'open', p); }
	f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return toBuf(ab, n);
}
export function writeFileSync(p, data, opts) { if (typeof p === 'number') { const path = fdPaths.get(p); if (path === undefined) { throw fail(E.EBADF, 'write', p); } p = path; } const flag = opts && typeof opts === 'object' ? opts.flag : undefined; if (flag && flag.includes('x') && std.open(String(p), 'rb')) { throw fail(E.EEXIST, 'open', p); } const f = std.open(String(p), flag && flag.includes('a') ? 'ab' : 'wb'); if (!f) { throw fail(E.EACCES, 'open', p); } if (typeof data === 'string') { f.puts(data); } else { f.write(data.buffer, data.byteOffset, data.byteLength); } f.close(); }
export function mkdirSync(p, opts) { const rec = opts && opts.recursive; if (rec) { let cur = String(p).startsWith('/') ? '' : '.'; for (const seg of String(p).split('/').filter(Boolean)) { cur += '/' + seg; const e = os.mkdir(cur, 0o777); if (e && e !== -E.EEXIST && e !== E.EEXIST) { throw fail(e, 'mkdir', cur); } } return; } const e = os.mkdir(String(p), 0o777); if (e) { throw fail(e, 'mkdir', p); } }
export function realpathSync(p) { const [r, e] = os.realpath(String(p)); if (e) { throw fail(e, 'realpath', p); } return r; }
export function unlinkSync(p) { const e = os.remove(String(p)); if (e) { throw fail(e, 'unlink', p); } }
export function renameSync(a, b) { const e = os.rename(String(a), String(b)); if (e) { throw fail(e, 'rename', a); } }
export function rmSync(p, o = {}) { const [st, e] = os.lstat(String(p)); if (e) { if (o.force) { return; } throw fail(e, 'rm', p); } if ((st.mode & S_IFMT) === S_IFDIR) { for (const n of readdirSync(p)) { rmSync(p + '/' + n, o); } } os.remove(String(p)); }
export function chmodSync() { }
export function mkdtempSync(prefix) { const p = prefix + Math.random().toString(36).slice(2, 8); mkdirSync(p); return p; }
const fdPaths = new Map();   // fd -> path, for fstat/ftruncate/futimes (qjs:os has no f* calls)
export function openSync(p, flags = 'r') { const f = typeof flags === 'string' ? ({ r: os.O_RDONLY, rs: os.O_RDONLY, 'r+': os.O_RDWR, w: os.O_WRONLY | os.O_CREAT | os.O_TRUNC, wx: os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_EXCL, xw: os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_EXCL, 'w+': os.O_RDWR | os.O_CREAT | os.O_TRUNC, 'wx+': os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_EXCL, a: os.O_WRONLY | os.O_CREAT | os.O_APPEND, ax: os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_EXCL, 'a+': os.O_RDWR | os.O_CREAT | os.O_APPEND, 'ax+': os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_EXCL }[flags] ?? os.O_RDONLY) : flags; const fd = os.open(String(p), f, 0o666); if (fd < 0) { throw fail(fd, 'open', p); } fdPaths.set(fd, String(p)); return fd; }
export function closeSync(fd) { os.close(fd); fdPaths.delete(fd); }
export function readSync(fd, buf, off = 0, len = buf.length - off, pos = null) { if (pos !== null) { os.seek(fd, pos, std.SEEK_SET); } return os.read(fd, buf.buffer, buf.byteOffset + off, len); }
export function writeSync(fd, data, off = 0, len) { if (typeof data === 'string') { const b = new TextEncoder().encode(data); return os.write(fd, b.buffer, 0, b.length); } return os.write(fd, data.buffer, data.byteOffset + off, len ?? data.byteLength - off); }
export function fdatasyncSync() { }

const cb = (fn) => (...a) => { const done = a.pop(); let r, err = null; try { r = fn(...a); } catch (e) { err = e; } queueMicrotask(() => err ? done(err) : done(null, r)); };
export const stat = cb(statSync), lstat = cb(lstatSync), readdir = cb(readdirSync), readFile = cb(readFileSync), writeFile = cb(writeFileSync), mkdir = cb(mkdirSync), realpath = cb(realpathSync), unlink = cb(unlinkSync), rename = cb(renameSync), open = cb(openSync), close = cb(closeSync), access = cb(accessSync), fdatasync = cb(fdatasyncSync);
export const exists = (p, done) => queueMicrotask(() => done(existsSync(p)));
export const read = (fd, buf, off, len, pos, done) => { let n, err = null; try { n = readSync(fd, buf, off, len, pos); } catch (e) { err = e; } queueMicrotask(() => done(err, n, buf)); };
export const write = (fd, data, ...rest) => { const done = rest.pop(); let n, err = null; try { n = writeSync(fd, data, ...rest); } catch (e) { err = e; } queueMicrotask(() => done(err, n, data)); };
const pr = (fn) => async (...a) => fn(...a);
export const promises = { stat: pr(statSync), lstat: pr(lstatSync), readdir: pr(readdirSync), readFile: pr(readFileSync), writeFile: pr(writeFileSync), mkdir: pr(mkdirSync), rm: pr(rmSync), rename: pr(renameSync), access: pr(accessSync), chmod: pr(chmodSync), realpath: pr(realpathSync), unlink: pr(unlinkSync), mkdtemp: pr(mkdtempSync), open: async () => { throw new Error('fs.promises.open not implemented'); } };
// ---- additions made in spike 5 (git and other ESM-only dependencies import these by name) ----
export function copyFileSync(a, b) { const d = readFileSync(a); writeFileSync(b, d); }
export function appendFileSync(p, data) { const f = std.open(String(p), 'ab'); if (!f) { throw fail(E.EACCES, 'open', p); } if (typeof data === 'string') { f.puts(data); } else { f.write(data.buffer, data.byteOffset, data.byteLength); } f.close(); }
export function readlinkSync(p) { const [r, e] = os.readlink(String(p)); if (e) { throw fail(e, 'readlink', p); } return r; }
export function symlinkSync(target, p) { const e = os.symlink(String(target), String(p)); if (e) { throw fail(e, 'symlink', p); } }
export function utimesSync(p, at, mt) { const e = os.utimes(String(p), +at * 1000, +mt * 1000); if (e) { throw fail(e, 'utime', p); } }
export function rmdirSync(p) { const e = os.remove(String(p)); if (e) { throw fail(e, 'rmdir', p); } }
export const copyFile = cb(copyFileSync), appendFile = cb(appendFileSync), readlink = cb(readlinkSync), symlink = cb(symlinkSync), utimes = cb(utimesSync), rmdir = cb(rmdirSync);
Object.assign(promises, { copyFile: pr(copyFileSync), appendFile: pr(appendFileSync), readlink: pr(readlinkSync), symlink: pr(symlinkSync), utimes: pr(utimesSync), rmdir: pr(rmdirSync) });
function cpSync(src, dst, o = {}) { const st = statSync(src); if (st.isDirectory()) { mkdirSync(dst, { recursive: true }); for (const n of readdirSync(src)) { cpSync(src + '/' + n, dst + '/' + n, o); } } else { copyFileSync(src, dst); } }
export { cpSync };
const nosys = (name) => async () => { throw Object.assign(new Error(`fs.promises.${name} is not implemented in this host`), { code: 'ENOSYS' }); };
Object.assign(promises, { cp: pr(cpSync), chown: nosys('chown'), lchmod: nosys('lchmod'), lchown: nosys('lchown'), link: nosys('link'), lutimes: nosys('lutimes'), opendir: nosys('opendir'), statfs: nosys('statfs'), truncate: nosys('truncate'), watch: nosys('watch') });
export const cp = cb(cpSync);
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

// ---- additions made in spike 10 (the file service of VS Code's own main/shared process: fd level operations, streams, FileHandle) ----
export function fstatSync(fd) { const p = fdPaths.get(fd); if (p === undefined) { throw fail(E.EBADF, 'fstat', fd); } return statSync(p); }
export function ftruncateSync(fd, len = 0) {
	const p = fdPaths.get(fd); if (p === undefined) { throw fail(E.EBADF, 'ftruncate', fd); }
	if (len === 0) { const t = os.open(p, os.O_WRONLY | os.O_TRUNC, 0o666); if (t >= 0) { os.close(t); } return; }
	const cur = readFileSync(p); const out = new Uint8Array(len); out.set(cur.subarray(0, Math.min(len, cur.length))); writeFileSync(p, out);
}
export function truncateSync(p, len = 0) { const fd = openSync(p, 'r+'); try { ftruncateSync(fd, len); } finally { closeSync(fd); } }
export function fsyncSync() { } export function futimesSync(fd, at, mt) { const p = fdPaths.get(fd); if (p !== undefined) { utimesSync(p, at, mt); } }
export function chownSync() { } export function lchownSync() { } export function linkSync(a, b) { copyFileSync(a, b); }
export function accessSyncMode(p) { return accessSync(p); }
export const fstat = cb(fstatSync), ftruncate = cb(ftruncateSync), truncate = cb(truncateSync), fsync = cb(fsyncSync), futimes = cb(futimesSync), chmod = cb(chmodSync), chown = cb(chownSync), link = cb(linkSync);
class FileHandle {
	constructor(fd) { this.fd = fd; }
	async stat() { return fstatSync(this.fd); } async truncate(len) { ftruncateSync(this.fd, len); } async sync() { } async datasync() { } async close() { closeSync(this.fd); }
	async read(buf, off = 0, len = buf.length - off, pos = null) { const n = readSync(this.fd, buf, off, len, pos); return { bytesRead: n, buffer: buf }; }
	async write(data, ...rest) { const n = writeSync(this.fd, data, ...rest); return { bytesWritten: n, buffer: data }; }
	async readFile(o) { return readFileSync(fdPaths.get(this.fd), o); } async writeFile(d) { writeFileSync(fdPaths.get(this.fd), d); }
}
Object.assign(promises, { open: async (p, flags) => new FileHandle(openSync(p, flags)), truncate: pr(truncateSync), link: pr(linkSync), chown: pr(chownSync), lchown: pr(lchownSync) });
export function createWriteStream(p, o = {}) {
	const { Writable } = globalThis.__builtins.stream; const flags = (typeof o === 'object' && o.flags) || 'w'; const fd = openSync(p, flags); let closed = false;
	const w = new Writable({ write(chunk, encoding, done) { try { writeSync(fd, typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk); done(); } catch (e) { done(e); } }, final(done) { if (!closed) { closed = true; closeSync(fd); } done(); }, destroy(err, done) { if (!closed) { closed = true; try { closeSync(fd); } catch { /* */ } } done(err); } });
	w.path = String(p); w.bytesWritten = 0; w.close = (done) => { w.end(); if (done) { w.once('close', done); } }; return w;
}
export function createReadStream(p, o = {}) {
	const { Readable } = globalThis.__builtins.stream; const fd = openSync(p, 'r'); const chunk = (typeof o === 'object' && o.highWaterMark) || 65536; let pos = (typeof o === 'object' && o.start) || 0; const end = (typeof o === 'object' && o.end !== undefined) ? o.end + 1 : Infinity;
	const r = new Readable({ highWaterMark: chunk, read() { try { const n = Math.min(chunk, end - pos); if (n <= 0) { closeSync(fd); this.push(null); return; } const b = new Uint8Array(n); const got = readSync(fd, b, 0, n, pos); if (!got) { closeSync(fd); this.push(null); return; } pos += got; const out = new Buf(b.buffer, 0, got); this.push(out); } catch (e) { this.destroy(e); } }, destroy(err, done) { try { closeSync(fd); } catch { /* */ } done(err); } });
	r.path = String(p); return r;
}
// fs.watch by polling every 500 ms (a real host would use inotify / ReadDirectoryChangesW): non-recursive, 'rename' for appearing/disappearing entries, 'change' for modified ones
export function watch(p, opts, listener) {
	if (typeof opts === 'function') { listener = opts; opts = {}; } p = String(p); if (!existsSync(p)) { throw fail(E.ENOENT, 'watch', p); }
	const w = new (globalThis.__builtins.events.EventEmitter)(); if (listener) { w.on('change', listener); }
	const snap = () => { const m = new Map(); try { const st = statSync(p); if (st.isDirectory()) { for (const n of readdirSync(p)) { try { const s2 = statSync(p + '/' + n); m.set(n, s2.mtimeMs + ':' + s2.size); } catch { /* vanished */ } } } else { m.set(p.split('/').pop(), st.mtimeMs + ':' + st.size); } } catch { /* gone */ } return m; };
	let prev = snap(); const t = setInterval(() => { const cur = snap(); for (const [n, sig] of cur) { if (!prev.has(n)) { w.emit('change', 'rename', n); } else if (prev.get(n) !== sig) { w.emit('change', 'change', n); } } for (const n of prev.keys()) { if (!cur.has(n)) { w.emit('change', 'rename', n); } } prev = cur; }, 500);
	w.close = () => { clearInterval(t); w.emit('close'); }; w.ref = () => w; w.unref = () => w; return w;
}
export function watchFile() { } export function unwatchFile() { }
Object.assign(constants, { COPYFILE_EXCL: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFLNK: 0o120000 });
export default { fstatSync, ftruncateSync, truncateSync, fsyncSync, futimesSync, chownSync, linkSync, fstat, ftruncate, truncate, fsync, futimes, chmod, chown, link, createWriteStream, createReadStream, watch, watchFile, unwatchFile, Stats, Dirent, statSync, lstatSync, existsSync, accessSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync, unlinkSync, renameSync, rmSync, chmodSync, mkdtempSync, openSync, closeSync, readSync, writeSync, fdatasyncSync, stat, lstat, readdir, readFile, writeFile, mkdir, realpath, unlink, rename, open, close, access, fdatasync, exists, read, write, promises, constants , copyFileSync, appendFileSync, readlinkSync, symlinkSync, utimesSync, rmdirSync, copyFile, appendFile, readlink, symlink, utimes, rmdir , cpSync, cp };
