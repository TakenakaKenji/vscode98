// MessagePort stand-ins that cross process boundaries. Electron hands real ports between processes; here every port lives in one process and the main
// process relays: a port posts { t:'portMsg', id, data, ports } to main, main forwards it to the process that holds the peer port.
// `send(msg)` is the process's channel to main (process.send / child.send).
export class RemotePort {
	constructor(id, send, makePort) {
		this._listeners = new Map(); this.id = id; this._send = send; this._make = makePort; this._queue = []; this._started = false; this._onmessage = null; this._closed = false;
	}
	get onmessage() { return this._onmessage; }
	set onmessage(fn) { this._onmessage = fn; this.start(); }
	postMessage(data, transfer) {
		if (this._closed) { return; }
		const ports = (Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || []).filter(p => p instanceof RemotePort).map(p => p.id);
		this._send({ t: 'portMsg', id: this.id, data, ports });
	}
	// own listener bookkeeping: the page's DOM environment and Node each have their own Event/EventTarget classes, and mixing them throws
	addEventListener(type, fn) { let l = this._listeners.get(type); if (!l) { l = []; this._listeners.set(type, l); } if (!l.includes(fn)) { l.push(fn); } }
	removeEventListener(type, fn) { const l = this._listeners.get(type); if (l) { const i = l.indexOf(fn); if (i >= 0) { l.splice(i, 1); } } }
	dispatchEvent(ev) { for (const fn of [...(this._listeners.get(ev.type) || [])]) { try { fn.call(this, ev); } catch (e) { console.error(e); } } return true; }
	// Node/Electron MessagePortMain flavour (utility processes use port.on('message', ...))
	on(type, fn) { const w = (ev) => fn(ev); (this._wrap ??= new Map()).set(fn, w); this.addEventListener(type, w); if (type === 'message') { this.start(); } return this; }
	once(type, fn) { const w = (ev) => { this.removeEventListener(type, w); fn(ev); }; this.addEventListener(type, w); if (type === 'message') { this.start(); } return this; }
	off(type, fn) { const w = this._wrap?.get(fn); if (w) { this.removeEventListener(type, w); this._wrap.delete(fn); } return this; }
	removeListener(type, fn) { return this.off(type, fn); }
	start() { this._started = true; const q = this._queue; this._queue = []; for (const e of q) { this._dispatch(e); } }
	close() { if (!this._closed) { this._closed = true; this._send({ t: 'portClose', id: this.id }); } }
	/** called by the process's message loop when main delivers a message to this port */
	_deliver(data, ports) { const ev = { type: 'message', data, ports, origin: '', source: null, target: this }; if (!this._started) { this._queue.push(ev); } else { this._dispatch(ev); } }
	_dispatch(ev) { try { if (this._onmessage) { this._onmessage(ev); } } catch (e) { console.error(e); } this.dispatchEvent(ev); }
}
/** registry of the ports a process holds, plus the delivery entry point */
export class PortTable {
	constructor(send) { this.send = send; this.ports = new Map(); }
	make(id) { let p = this.ports.get(id); if (!p) { p = new RemotePort(id, this.send); this.ports.set(id, p); } return p; }
	deliver(m) { const p = this.ports.get(m.id); if (!p) { return false; } p._deliver(m.data, (m.ports || []).map(id => this.make(id))); return true; }
}
