// Minimal EventEmitter (the real one has more: captureRejections, errorMonitor, once() promises, setMaxListeners warnings...).
// `this._ev` is created lazily: native-style subclasses (e.g. the sqlite3 addon's Database) never run the EventEmitter constructor, as in Node.
const evs = (o) => o._ev ?? (o._ev = new Map());
class EventEmitterMethods {
	// as in Node, on / off are the very same functions as addListener / removeListener (aliased below): a subclass that overrides one name and calls the
	// base implementation through the other (readable-stream, the @vscode/sqlite3 Database) must not end up back in its own override
	addListener(n, f) { (evs(this).get(n) ?? evs(this).set(n, []).get(n)).push(f); return this; }
	prependListener(n, f) { (evs(this).get(n) ?? evs(this).set(n, []).get(n)).unshift(f); return this; }
	once(n, f) { const w = (...a) => { this.off(n, w); f.apply(this, a); }; w.listener = f; return this.on(n, w); }
	removeListener(n, f) { const l = evs(this).get(n); if (l) { const i = l.findIndex(x => x === f || x.listener === f); if (i >= 0) { l.splice(i, 1); } } return this; }
	removeAllListeners(n) { if (n === undefined) { evs(this).clear(); } else { evs(this).delete(n); } return this; }
	emit(n, ...a) { const l = evs(this).get(n); if (!l || !l.length) { if (n === 'error') { throw a[0] instanceof Error ? a[0] : new Error('Unhandled error: ' + a[0]); } return false; } for (const f of l.slice()) { f.apply(this, a); } return true; }
	listenerCount(n) { return (evs(this).get(n) || []).length; }
	listeners(n) { return (evs(this).get(n) || []).map(f => f.listener || f); }
	eventNames() { return [...evs(this).keys()]; }
	setMaxListeners(n) { this._max = n; return this; }
	getMaxListeners() { return this._max; }
}
EventEmitterMethods.prototype.on = EventEmitterMethods.prototype.addListener; EventEmitterMethods.prototype.off = EventEmitterMethods.prototype.removeListener;
// A plain function constructor (not a class): npm packages such as readable-stream do `EventEmitter.call(this)` / util.inherits, which a class forbids.
export function EventEmitter() { this._ev = new Map(); this._max = 10; }
for (const k of Object.getOwnPropertyNames(EventEmitterMethods.prototype)) { if (k !== 'constructor') { Object.defineProperty(EventEmitter.prototype, k, { value: EventEmitterMethods.prototype[k], writable: true, configurable: true, enumerable: true }); } }
EventEmitter.listenerCount = (em, n) => em.listenerCount(n);
EventEmitter.EventEmitter = EventEmitter; EventEmitter.defaultMaxListeners = 10;
EventEmitter.setMaxListeners = () => { }; EventEmitter.getMaxListeners = () => 10;
export const once = (em, n) => new Promise(res => em.once(n, (...a) => res(a)));
export default EventEmitter;
