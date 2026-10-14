// MessagePort / MessageChannel and window.postMessage between the windows of one process (the page and its iframes). Delivery is asynchronous (a timer task), a port starts
// when `onmessage` is assigned or start() is called, and ports can be transferred with postMessage(data, origin, [port]) / port.postMessage(data, [port]).
import { EventTarget, MessageEvent } from './dom.js';

const portsOf = (transfer) => (Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || []).filter((p) => p instanceof MessagePort);

export class MessagePort extends EventTarget {
	constructor() { super(); this.__other = null; this.__queue = []; this.__started = false; this.__onmessage = null; this.__closed = false; }
	get onmessage() { return this.__onmessage; } set onmessage(fn) { this.__onmessage = typeof fn === 'function' ? fn : null; this.start(); }
	get onmessageerror() { return null; } set onmessageerror(v) { }
	start() { if (this.__started) { return; } this.__started = true; const q = this.__queue; this.__queue = []; for (const m of q) { this.__dispatch(m); } }
	postMessage(data, transfer) {
		const other = this.__other; if (this.__closed || !other) { return; } const ports = portsOf(transfer);
		setTimeout(() => other.__receive(data, ports), 0);
	}
	close() { this.__closed = true; if (this.__other) { this.__other.__other = null; } this.__other = null; }
	__receive(data, ports) { if (this.__closed) { return; } if (!this.__started) { this.__queue.push({ data, ports }); } else { this.__dispatch({ data, ports }); } }
	__dispatch({ data, ports }) { const ev = new MessageEvent('message', { data, ports, origin: '', source: null }); try { if (this.__onmessage) { this.__onmessage.call(this, ev); } } catch (e) { (globalThis.console.error || globalThis.console.log).call(globalThis.console, '[onmessage]', e && (e.stack || e)); } this.dispatchEvent(ev); }
}
export class MessageChannel { constructor() { this.port1 = new MessagePort(); this.port2 = new MessagePort(); this.port1.__other = this.port2; this.port2.__other = this.port1; } }

/** window.postMessage: `target` is the receiving window (global object), `source` the sending one; the event is a task of the target's event loop */
export function postMessageToWindow(target, source, data, targetOrigin, transfer) {
	if (typeof targetOrigin === 'object' && targetOrigin) { transfer = targetOrigin.transfer; targetOrigin = targetOrigin.targetOrigin; }   // postMessage(data, { targetOrigin, transfer })
	const ports = portsOf(transfer); const origin = source && source.origin !== undefined ? String(source.origin) : '';
	setTimeout(() => { try { target.dispatchEvent(new MessageEvent('message', { data, origin, source, ports })); } catch (e) { (globalThis.console.error || globalThis.console.log).call(globalThis.console, '[message]', e && (e.stack || e)); } }, 0);
}
