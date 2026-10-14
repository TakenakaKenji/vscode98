// node-pty stand-in. The real module drives a pseudo-terminal (ConPTY/winpty/openpty) through a native addon that cannot be loaded here, and Windows 7 has no ConPTY anyway.
// This version runs the shell with plain pipes and supplies the line discipline a terminal driver would: typed characters are echoed locally, Backspace edits the pending line,
// Enter sends the line to the shell, escape sequences (cursor keys) are dropped, and the shell's LF line ends become CRLF for the terminal emulator.
// Limits: no full-screen programs, no history or tab completion in the shell, Ctrl+C interrupts only where a signal exists (not on Windows).
import { spawn as spawnChild } from 'node:child_process';
import path from 'node:path';

class Emitter {
	constructor() { this.l = new Set(); }
	event = (fn) => { this.l.add(fn); return { dispose: () => this.l.delete(fn) }; };
	fire(v) { for (const f of [...this.l]) { try { f(v); } catch (e) { console.error('[node-pty] listener failed', e); } } }
}
export class Pty {
	constructor(file, args, opts) {
		this.cols = opts.cols || 80; this.rows = opts.rows || 24; this.process = path.basename(String(file)).replace(/\.exe$/i, ''); this.handleFlowControl = !!opts.handleFlowControl; this._data = new Emitter(); this._exit = new Emitter(); this.onData = this._data.event; this.onExit = this._exit.event;
		this._line = ''; this._done = false; const win = process.platform === 'win32';
		const argv = Array.isArray(args) ? [...args] : []; if (!win && /^(bash|sh|zsh)$/.test(this.process) && !argv.includes('-i')) { argv.push('-i'); }
		const env = { ...(opts.env || process.env) }; env.TERM ??= 'xterm-256color';
		this._child = spawnChild(String(file), argv, { cwd: opts.cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		this.pid = this._child.pid || 0;
		const out = (d) => this._data.fire(String(d).replace(/\r?\n/g, '\r\n'));
		this._child.stdout?.on('data', out); this._child.stderr?.on('data', out);
		this._child.on('error', (e) => { this._data.fire(`\r\n[could not start ${file}: ${e.message}]\r\n`); this._finish(1, 0); });
		this._child.on('exit', (code, signal) => this._finish(code ?? 0, signal ? 1 : 0));
	}
	_finish(exitCode, signal) { if (this._done) { return; } this._done = true; this._exit.fire({ exitCode, signal }); }
	_send(s) { try { this._child.stdin?.write(s); } catch { /* the shell is gone */ } }
	write(data) {
		if (this._done) { return; } const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); const echo = (s) => this._data.fire(s);
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (ch === '\x1b') { if (text[i + 1] === '[' || text[i + 1] === 'O') { i += 2; while (i < text.length && !/[A-Za-z~]/.test(text[i])) { i++; } } continue; }   // cursor keys, Delete, Home/End: dropped
			if (ch === '\r' || ch === '\n') { if (ch === '\n' && text[i - 1] === '\r') { continue; } echo('\r\n'); this._send(this._line + (process.platform === 'win32' ? '\r\n' : '\n')); this._line = ''; }
			else if (ch === '\x7f' || ch === '\b') { if (this._line) { this._line = this._line.slice(0, -1); echo('\b \b'); } }
			else if (ch === '\x03') { this._line = ''; echo('^C\r\n'); if (process.platform !== 'win32') { try { this._child.kill('SIGINT'); } catch { /* gone */ } } else { this._send('\r\n'); } }
			else if (ch === '\x04') { if (!this._line) { try { this._child.stdin?.end(); } catch { /* gone */ } } }
			else if (ch === '\x15') { while (this._line) { this._line = this._line.slice(0, -1); echo('\b \b'); } }   // Ctrl+U
			else if (ch >= ' ') { this._line += ch; echo(ch); }
		}
	}
	resize(cols, rows) { this.cols = cols; this.rows = rows; }
	clear() { }
	pause() { } resume() { }
	kill(signal) { try { this._child.kill(signal); } catch { /* gone */ } }
}
export function spawn(file, args, opts = {}) { return new Pty(file, args, opts); }
export default { spawn };
