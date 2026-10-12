// `fs` shim for the spike, on qjs:os / qjs:std. Covers the functions the process trace measured (sync + callback + promises); no streams, no watch.
// Notes for a real implementation: no fs.watch/watchFile here (needs ReadDirectoryChangesW etc.), no file descriptors beyond os.open fds, no Buffer I/O beyond a tiny shim.
import * as os from 'qjs:os';
import * as std from 'qjs:std';

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000, S_IFLNK = 0o120000;
const E = std.Error;   // errno constants live on std.Error in QuickJS (E.ENOENT etc. do not exist)
const CODES = { [E.ENOENT]: 'ENOENT', [E.EEXIST]: 'EEXIST', [E.ENOTDIR]: 'ENOTDIR', [E.EACCES]: 'EACCES', [E.EISDIR]: 'EISDIR', [E.EINVAL]: 'EINVAL', [E.EBADF]: 'EBADF', [E.ENOTEMPTY]: 'ENOTEMPTY', [E.EPERM]: 'EPERM' };
function fail(errno, syscall, path) { const e = new Error(`${CODES[-errno] || CODES[errno] || 'E' + errno}: ${syscall} '${path}'`); e.errno = -Math.abs(errno); e.code = CODES[Math.abs(errno)] || 'EUNKNOWN'; e.syscall = syscall; e.path = path; return e; }

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
	if (encoding) { const s = std.loadFile(String(p)); if (s === null) { throw fail(E.ENOENT, 'open', p); } return s; }
	const f = std.open(String(p), 'rb'); if (!f) { throw fail(E.ENOENT, 'open', p); }
	f.seek(0, std.SEEK_END); const n = f.tell(); f.seek(0, std.SEEK_SET); const ab = new ArrayBuffer(n); f.read(ab, 0, n); f.close(); return toBuf(ab, n);
}
export function writeFileSync(p, data) { const f = std.open(String(p), 'wb'); if (!f) { throw fail(E.EACCES, 'open', p); } if (typeof data === 'string') { f.puts(data); } else { f.write(data.buffer, data.byteOffset, data.byteLength); } f.close(); }
export function mkdirSync(p, opts) { const rec = opts && opts.recursive; if (rec) { let cur = String(p).startsWith('/') ? '' : '.'; for (const seg of String(p).split('/').filter(Boolean)) { cur += '/' + seg; const e = os.mkdir(cur, 0o777); if (e && e !== -E.EEXIST && e !== E.EEXIST) { throw fail(e, 'mkdir', cur); } } return; } const e = os.mkdir(String(p), 0o777); if (e) { throw fail(e, 'mkdir', p); } }
export function realpathSync(p) { const [r, e] = os.realpath(String(p)); if (e) { throw fail(e, 'realpath', p); } return r; }
export function unlinkSync(p) { const e = os.remove(String(p)); if (e) { throw fail(e, 'unlink', p); } }
export function renameSync(a, b) { const e = os.rename(String(a), String(b)); if (e) { throw fail(e, 'rename', a); } }
export function rmSync(p, o = {}) { const [st, e] = os.lstat(String(p)); if (e) { if (o.force) { return; } throw fail(e, 'rm', p); } if ((st.mode & S_IFMT) === S_IFDIR) { for (const n of readdirSync(p)) { rmSync(p + '/' + n, o); } } os.remove(String(p)); }
export function chmodSync() { }
export function mkdtempSync(prefix) { const p = prefix + Math.random().toString(36).slice(2, 8); mkdirSync(p); return p; }
export function openSync(p, flags = 'r') { const f = typeof flags === 'string' ? ({ r: os.O_RDONLY, w: os.O_WRONLY | os.O_CREAT | os.O_TRUNC, a: os.O_WRONLY | os.O_CREAT | os.O_APPEND, 'r+': os.O_RDWR }[flags] ?? os.O_RDONLY) : flags; const fd = os.open(String(p), f, 0o666); if (fd < 0) { throw fail(fd, 'open', p); } return fd; }
export function closeSync(fd) { os.close(fd); }
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
export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
export default { Stats, Dirent, statSync, lstatSync, existsSync, accessSync, readdirSync, readFileSync, writeFileSync, mkdirSync, realpathSync, unlinkSync, renameSync, rmSync, chmodSync, mkdtempSync, openSync, closeSync, readSync, writeSync, fdatasyncSync, stat, lstat, readdir, readFile, writeFile, mkdir, realpath, unlink, rename, open, close, access, fdatasync, exists, read, write, promises, constants };
