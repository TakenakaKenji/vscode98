// JS stand-in for the native @vscode/spdlog logger: appends formatted lines to the log file. (The real module is a C++ addon; XP/98 need either a port or this.)
import * as std from 'qjs:std';
const levels = ['trace', 'debug', 'info', 'warning', 'error', 'critical', 'off'];
class Logger {
	constructor(name, filename) { this.name = name; this.filename = filename; this.level = 2; this.pattern = null; }
	_w(l, msg) { if (l < this.level) { return; } const f = std.open(this.filename, 'a'); if (f) { f.puts(`${new Date().toISOString()} [${levels[l]}] ${msg}\n`); f.close(); } }
	trace(m) { this._w(0, m); } debug(m) { this._w(1, m); } info(m) { this._w(2, m); } warn(m) { this._w(3, m); } error(m) { this._w(4, m); } critical(m) { this._w(5, m); }
	getLevel() { return this.level; } setLevel(l) { this.level = l; } flush() { } drop() { } clearFormatters() { } setPattern(p) { this.pattern = p; }
}
export async function createAsyncRotatingLogger(name, filename) { return new Logger(name, filename); }
export async function createRotatingLogger(name, filename) { return new Logger(name, filename); }
export function setFlushOn() { } export function setLevel() { } export function version() { return 'shim'; }
export { Logger };
export default { createAsyncRotatingLogger, createRotatingLogger, setFlushOn, setLevel, version, Logger };
