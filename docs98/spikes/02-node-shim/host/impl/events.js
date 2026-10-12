// Minimal EventEmitter (the real one has more: captureRejections, errorMonitor, once() promises, setMaxListeners warnings...).
class EventEmitterMethods {
	on(n, f) { (this._ev.get(n) ?? this._ev.set(n, []).get(n)).push(f); return this; }
	addListener(n, f) { return this.on(n, f); }
	prependListener(n, f) { (this._ev.get(n) ?? this._ev.set(n, []).get(n)).unshift(f); return this; }
	once(n, f) { const w = (...a) => { this.off(n, w); f.apply(this, a); }; w.listener = f; return this.on(n, w); }
	off(n, f) { const l = this._ev.get(n); if (l) { const i = l.findIndex(x => x === f || x.listener === f); if (i >= 0) { l.splice(i, 1); } } return this; }
	removeListener(n, f) { return this.off(n, f); }
	removeAllListeners(n) { if (n === undefined) { this._ev.clear(); } else { this._ev.delete(n); } return this; }
	emit(n, ...a) { const l = this._ev.get(n); if (!l || !l.length) { if (n === 'error') { throw a[0] instanceof Error ? a[0] : new Error('Unhandled error: ' + a[0]); } return false; } for (const f of l.slice()) { f.apply(this, a); } return true; }
	listenerCount(n) { return (this._ev.get(n) || []).length; }
	listeners(n) { return (this._ev.get(n) || []).map(f => f.listener || f); }
	eventNames() { return [...this._ev.keys()]; }
	setMaxListeners(n) { this._max = n; return this; }
	getMaxListeners() { return this._max; }
}
// A plain function constructor (not a class): npm packages such as readable-stream do `EventEmitter.call(this)` / util.inherits, which a class forbids.
export function EventEmitter() { this._ev = new Map(); this._max = 10; }
for (const k of Object.getOwnPropertyNames(EventEmitterMethods.prototype)) { if (k !== 'constructor') { Object.defineProperty(EventEmitter.prototype, k, { value: EventEmitterMethods.prototype[k], writable: true, configurable: true }); } }
EventEmitter.listenerCount = (em, n) => em.listenerCount(n);
EventEmitter.EventEmitter = EventEmitter; EventEmitter.defaultMaxListeners = 10;
EventEmitter.setMaxListeners = () => { }; EventEmitter.getMaxListeners = () => 10;
export const once = (em, n) => new Promise(res => em.once(n, (...a) => res(a)));
export default EventEmitter;
