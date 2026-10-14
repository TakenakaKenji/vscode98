// CPU / memory micro-benchmarks for the vscode98 host, to compare machines (a VM against a normal PC): each test prints its time in milliseconds.
// Run with run-bench.cmd (output: results\bench.txt). Nothing is installed or written besides that file.
const T = [];
function time(name, fn) { const t0 = Date.now(); const r = fn(); const ms = Date.now() - t0; T.push([name, ms]); console.log(name.padEnd(34) + String(ms).padStart(7) + ' ms' + (r === undefined ? '' : '   (' + r + ')')); }
time('integer loop 40M', () => { let s = 0; for (let i = 0; i < 40000000; i++) { s = (s + i * 3) & 0xffffff; } return s; });
time('float math 6M', () => { let s = 0; for (let i = 1; i < 6000000; i++) { s += Math.sqrt(i) * Math.sin(i); } return Math.round(s); });
time('small objects 2M (alloc + keep)', () => { const a = []; for (let i = 0; i < 2000000; i++) { a.push({ a: i, b: 'x', c: null }); } return a.length; });
time('short-lived objects 6M (GC churn)', () => { let s = 0; for (let i = 0; i < 6000000; i++) { const o = { v: i, w: [i] }; s += o.w[0] & 1; } return s; });
time('string build + split 400k', () => { let n = 0; for (let i = 0; i < 400000; i++) { n += ('class-' + i + ' other-' + (i & 7) + ' third').split(' ').length; } return n; });
time('regexp 400k', () => { let n = 0; const re = /^(\w+)-(\d+)\s+(\w+)/; for (let i = 0; i < 400000; i++) { const m = re.exec('monaco-' + i + ' editor'); if (m) { n += m[2].length; } } return n; });
time('Map set/get 1M', () => { const m = new Map(); for (let i = 0; i < 1000000; i++) { m.set('k' + i, i); } let s = 0; for (let i = 0; i < 1000000; i++) { s += m.get('k' + i); } return s; });
time('array sort 400k numbers', () => { const a = []; let x = 12345; for (let i = 0; i < 400000; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; a.push(x); } a.sort((p, q) => p - q); return a[0]; });
time('typed array fill/sum 15M', () => { const a = new Int32Array(1 << 20); let s = 0; for (let r = 0; r < 15; r++) { for (let i = 0; i < a.length; i++) { a[i] = i ^ r; s += a[i]; } } return s; });
time('big heap 1M objects, 5 passes', () => { const a = []; for (let i = 0; i < 1000000; i++) { a.push({ i, s: 'v' + i, arr: [i, i + 1] }); } let s = 0; for (let p = 0; p < 5; p++) { for (let i = 0; i < a.length; i++) { s += a[i].arr[1] - a[i].i; } } return s; });
console.log('total'.padEnd(34) + String(T.reduce((a, x) => a + x[1], 0)).padStart(7) + ' ms');
