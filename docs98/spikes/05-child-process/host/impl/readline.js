// `readline` subset: createInterface({ input, output }) emitting 'line' / 'close' for line-oriented streams (what tsserver's stdio mode, git helpers and many CLIs use).
// No terminal mode, history or completion.
import { EventEmitter } from '__SHIMS__/events.js';

export class Interface extends EventEmitter {
	constructor(input, output, completer, terminal) {
		super();
		const o = input && typeof input === 'object' && !input.on ? input : { input, output };
		this.input = o.input; this.output = o.output; this.terminal = false; this.closed = false; this._buf = ''; this._prompt = o.prompt ?? '> '; this._questions = [];
		if (this.input) {
			this.input.setEncoding?.('utf8');
			this._onData = (d) => { this._buf += typeof d === 'string' ? d : String(d); let i; while ((i = this._buf.search(/\r?\n/)) >= 0) { const m = /\r?\n/.exec(this._buf); const line = this._buf.slice(0, m.index); this._buf = this._buf.slice(m.index + m[0].length); this._line(line); } };
			this._onEnd = () => { if (this._buf.length) { const l = this._buf; this._buf = ''; this._line(l); } this.close(); };
			this.input.on('data', this._onData); this.input.on('end', this._onEnd);
		}
	}
	_line(l) { const q = this._questions.shift(); if (q) { q(l); } else { this.emit('line', l); } }
	setPrompt(p) { this._prompt = p; } getPrompt() { return this._prompt; } prompt() { this.output?.write?.(this._prompt); }
	question(query, opts, cb) { cb = typeof opts === 'function' ? opts : cb; this.output?.write?.(query); this._questions.push(cb); }
	write(d) { this.output?.write?.(d); } pause() { this.input?.pause?.(); return this; } resume() { this.input?.resume?.(); return this; }
	close() { if (this.closed) { return; } this.closed = true; this.input?.off?.('data', this._onData); this.input?.off?.('end', this._onEnd); this.emit('close'); }
	[Symbol.asyncIterator]() { const q = [], w = []; let done = false; this.on('line', l => { if (w.length) { w.shift()({ value: l, done: false }); } else { q.push(l); } }); this.on('close', () => { done = true; while (w.length) { w.shift()({ value: undefined, done: true }); } }); return { next: () => q.length ? Promise.resolve({ value: q.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise(r => w.push(r)), return: () => { this.close(); return Promise.resolve({ done: true }); }, [Symbol.asyncIterator]() { return this; } }; }
}
export function createInterface(input, output, completer, terminal) { return new Interface(input, output, completer, terminal); }
export const clearLine = (s, d, cb) => { cb?.(); return true; }, clearScreenDown = (s, cb) => { cb?.(); return true; }, cursorTo = (s, x, y, cb) => { (typeof y === 'function' ? y : cb)?.(); return true; }, moveCursor = (s, dx, dy, cb) => { cb?.(); return true; }, emitKeypressEvents = () => { };
export default { Interface, createInterface, clearLine, clearScreenDown, cursorTo, moveCursor, emitKeypressEvents };
