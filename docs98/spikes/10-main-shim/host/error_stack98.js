// QuickJS's `error.stack` is only the trace ("    at f (file:1:2)"); Node's and V8's start with "Name: message". VS Code logs `error.stack` in many places and would lose the message.
// `stack` is an accessor on Error.prototype in QuickJS-ng, so it can be wrapped once for all error types.
const d = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
if (d && d.get && !d.get.__withHeader) {
	const custom = new WeakMap();
	const get = function () {
		if (custom.has(this)) { return custom.get(this); }
		const raw = d.get.call(this); if (typeof raw !== 'string') { return raw; }
		let head; try { head = Error.prototype.toString.call(this); } catch { head = 'Error'; }
		return raw.startsWith(head) ? raw : head + (raw ? '\n' + raw : '');
	};
	get.__withHeader = true;
	Object.defineProperty(Error.prototype, 'stack', { get, set(v) { custom.set(this, v); }, enumerable: d.enumerable, configurable: true });
}
