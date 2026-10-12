// Replays a recorded sequence of OnigScanner.findNextMatchSync calls (from tokenize_bench.mjs --record, 68,741 calls from tokenizing 8,482 lines of TypeScript)
// against one Oniguruma implementation and checks EVERY result against the recording. Isolates regex-matching + marshalling cost from the TextMate JavaScript.
//   node replay_bench.mjs --impl wasm --trace /tmp/trace.json     |    qjs-spike4 replay_bench.mjs --impl wasm|native|wasm2c --trace ...
import { opt, readText, now, print, loadOnig, isQjs } from './common.mjs';
const impl = opt('impl', 'wasm'), reps = Number(opt('reps', '1'));
const trace = JSON.parse(readText(opt('trace', '/tmp/claude-0/onig-trace.json')));
const onig = await loadOnig(impl);
const scanners = new Map();
let mismatches = 0, firstBad = null; const scannerErrors = [];
const t0 = now(); let tMatch = 0;
for (let rep = 0; rep < reps; rep++) {
	let curStr = -1, curObj = null;
	for (let i = 0; i < trace.calls.length; i++) {
		const [sid, stri, pos, opts, wantIdx, wantCaps] = trace.calls[i];
		let sc = scanners.get(sid); if (sc === undefined) { try { sc = onig.createOnigScanner(trace.scanners[sid]); } catch (e) { sc = null; scannerErrors.push({ sid, patterns: trace.scanners[sid], error: String(e.message) }); } scanners.set(sid, sc); }
		if (sc === null) { continue; }
		if (stri !== curStr) { if (curObj && curObj.dispose) { curObj.dispose(); } curObj = onig.createOnigString(trace.strings[stri]); curStr = stri; }
		const a = now();
		const r = sc.findNextMatchSync(curObj, pos, opts);
		tMatch += now() - a;
		const gotIdx = r ? r.index : -1, gotCaps = r ? r.captureIndices.map(c => c.start + ':' + c.end).join(',') : '';
		if (gotIdx !== wantIdx || gotCaps !== wantCaps) { mismatches++; if (!firstBad) { firstBad = { i, sid, stri, pos, opts, want: [wantIdx, wantCaps], got: [gotIdx, gotCaps] }; } }
	}
}
const total = now() - t0;
print(JSON.stringify({ impl, engine: isQjs ? 'quickjs' : 'node', calls: trace.calls.length * reps, mismatches, scannerErrors, firstMismatch: firstBad, ms: { total: Math.round(total), insideFindNextMatchSync: Math.round(tMatch) }, usPerCall: +(tMatch * 1000 / (trace.calls.length * reps)).toFixed(2) }));
