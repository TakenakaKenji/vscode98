// Preloaded (node --import) into every utility process the main process forks: Electron's `process.parentPort`, the `electron` stub for the few modules that import it,
// and the port table that lets MessagePorts handed over by main work.
import { register } from 'node:module';
import { EventEmitter } from 'node:events';
import { PortTable } from './ports98.js';
import { encode, decode } from './codec98.js';
register('./hooks.mjs', import.meta.url);
import fs from 'node:fs';
const TRACE = process.env.UTIL_TRACE ? (m) => fs.appendFileSync(process.env.UTIL_TRACE + '.' + process.pid, m + '\n') : null;
const short = (d) => { try { return JSON.stringify(d, (k, v) => (v && v.type === 'Buffer') || ArrayBuffer.isView(v) ? '[bytes ' + (v.length ?? v.byteLength) + ']' : v)?.slice(0, 160); } catch { return '?'; } };
const send = (m) => { TRACE?.('-> main ' + m.t + ' ' + (m.id ?? '') + ' ' + short(m.data)); process.send(encode(m)); };
const table = new PortTable(send);
// like an Electron MessagePortMain, parentPort holds messages back until someone listens for them (the entry module is still loading when the first one arrives)
class ParentPort extends EventEmitter {
	constructor() { super(); this._queue = []; this._started = false; }
	on(ev, fn) { super.on(ev, fn); if (ev === 'message') { this.start(); } return this; }
	once(ev, fn) { super.once(ev, fn); if (ev === 'message') { this.start(); } return this; }
	start() { if (this._started) { return; } this._started = true; const q = this._queue; this._queue = []; for (const m of q) { this.emit('message', m); } }
	_incoming(m) { if (this._started) { this.emit('message', m); } else { this._queue.push(m); } }
}
const parentPort = new ParentPort();
parentPort.postMessage = (data, transfer) => { send({ t: 'upm', data }); };
parentPort.close = () => { };
process.parentPort = parentPort;
process.on('message', (m0) => {
	const m = decode(m0); if (!m || !m.t) { return; }
	TRACE?.('<- main ' + m.t + ' ' + (m.id ?? '') + ' ports=' + short(m.ports) + ' ' + short(m.data));
	if (m.t === 'upm') { parentPort._incoming({ data: m.data, ports: (m.ports || []).map(id => table.make(id)) }); }
	else if (m.t === 'portMsg') { table.deliver(m); }
	else if (m.t === 'portClose') { const p = table.ports.get(m.id); if (p) { p._closed = true; p.dispatchEvent({ type: 'close' }); } }
});
if (TRACE) {
	process.on('uncaughtException', (e) => TRACE('uncaughtException ' + (e && e.stack || e)));
	process.on('unhandledRejection', (e) => TRACE('unhandledRejection ' + (e && e.stack || e)));
	process.on('exit', (c) => TRACE('exit ' + c));
}
