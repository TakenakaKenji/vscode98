// Spike 1b: which standard built-ins exist in this engine? Run:  qjs feature_probe.js   (prints MISSING entries as JSON on the last line)
const probes = {
	// ES2015-ES2024 built-ins the VS Code code base can reach
	'Array.fromAsync': () => typeof Array.fromAsync, 'Array.prototype.at': () => typeof [].at, 'Array.prototype.flat': () => typeof [].flat,
	'Array.prototype.findLast': () => typeof [].findLast, 'Array.prototype.toSorted': () => typeof [].toSorted, 'Array.prototype.toSpliced': () => typeof [].toSpliced,
	'Array.prototype.with': () => typeof [].with, 'Object.groupBy': () => typeof Object.groupBy, 'Map.groupBy': () => typeof Map.groupBy,
	'Object.hasOwn': () => typeof Object.hasOwn, 'Object.fromEntries': () => typeof Object.fromEntries, 'Promise.withResolvers': () => typeof Promise.withResolvers,
	'Promise.allSettled': () => typeof Promise.allSettled, 'Promise.any': () => typeof Promise.any, 'String.prototype.replaceAll': () => typeof ''.replaceAll,
	'String.prototype.at': () => typeof ''.at, 'String.prototype.isWellFormed': () => typeof ''.isWellFormed, 'String.prototype.normalize': () => typeof ''.normalize,
	'String.prototype.localeCompare': () => typeof ''.localeCompare, 'String.raw': () => typeof String.raw,
	'ArrayBuffer.prototype.resize': () => typeof ArrayBuffer.prototype.resize, 'ArrayBuffer.prototype.transfer': () => typeof ArrayBuffer.prototype.transfer,
	'SharedArrayBuffer': () => typeof SharedArrayBuffer, 'Atomics': () => typeof Atomics, 'WeakRef': () => typeof WeakRef, 'FinalizationRegistry': () => typeof FinalizationRegistry,
	'BigInt': () => typeof BigInt, 'Symbol.asyncIterator': () => typeof Symbol.asyncIterator, 'Proxy': () => typeof Proxy, 'Reflect': () => typeof Reflect,
	'Set.prototype.union (ES2025)': () => typeof Set.prototype.union, 'Iterator.prototype.map (ES2025)': () => typeof (globalThis.Iterator && Iterator.prototype.map),
	'structuredClone': () => typeof structuredClone, 'queueMicrotask': () => typeof queueMicrotask, 'globalThis': () => typeof globalThis,
	'Error.captureStackTrace (V8)': () => typeof Error.captureStackTrace, 'Error.stackTraceLimit (V8)': () => typeof Error.stackTraceLimit,
	'Error.prepareStackTrace (V8)': () => typeof Error.prepareStackTrace, 'Error cause': () => typeof new Error('x', { cause: 1 }).cause,
	'Date.prototype.toLocaleString': () => typeof new Date().toLocaleString, 'Number.prototype.toLocaleString': () => typeof (1).toLocaleString,
	// Intl and friends
	'Intl': () => typeof Intl, 'Intl.DateTimeFormat': () => typeof (globalThis.Intl && Intl.DateTimeFormat), 'Intl.NumberFormat': () => typeof (globalThis.Intl && Intl.NumberFormat),
	'Intl.Collator': () => typeof (globalThis.Intl && Intl.Collator), 'Intl.Segmenter': () => typeof (globalThis.Intl && Intl.Segmenter), 'Intl.PluralRules': () => typeof (globalThis.Intl && Intl.PluralRules),
	'Intl.RelativeTimeFormat': () => typeof (globalThis.Intl && Intl.RelativeTimeFormat), 'Intl.ListFormat': () => typeof (globalThis.Intl && Intl.ListFormat),
	'Intl.DisplayNames': () => typeof (globalThis.Intl && Intl.DisplayNames), 'Intl.Locale': () => typeof (globalThis.Intl && Intl.Locale),
	// Web-platform globals that are NOT DOM but are not part of ECMAScript either
	'TextEncoder': () => typeof TextEncoder, 'TextDecoder': () => typeof TextDecoder, 'URL': () => typeof URL, 'URLSearchParams': () => typeof URLSearchParams,
	'AbortController': () => typeof AbortController, 'setTimeout': () => typeof setTimeout, 'setInterval': () => typeof setInterval, 'console': () => typeof console,
	'performance.now': () => typeof (globalThis.performance && performance.now), 'atob': () => typeof atob, 'btoa': () => typeof btoa, 'crypto.getRandomValues': () => typeof (globalThis.crypto && crypto.getRandomValues),
	'WebAssembly': () => typeof WebAssembly, 'fetch': () => typeof fetch, 'Blob': () => typeof Blob, 'MessageChannel': () => typeof MessageChannel, 'Worker': () => typeof Worker,
};
const missing = [], present = [];
for (const [k, f] of Object.entries(probes)) { let t; try { t = f(); } catch (e) { t = 'throws:' + e.message; } (t === 'undefined' || t.startsWith('throws') ? missing : present).push(k); }
console.log('present (' + present.length + '): ' + present.join(', '));
console.log('MISSING (' + missing.length + '): ' + JSON.stringify(missing));
