// Parts shared by the Node and QuickJS boot harnesses.
/** pump timers and animation frames until the DOM stops changing (or the time is up); returns when stable */
export async function runScenario(ctx, { seconds = 30, label = '', stableRounds = 25 } = {}) {
	const { env, doc, note } = ctx; let stable = 0, last = -1; const deadline = performance.now() + seconds * 1000;
	while (performance.now() < deadline && stable < stableRounds) {
		const ti = performance.now(); let tf = 0; await new Promise(r => setTimeout(() => { tf = performance.now(); r(); }, 20)); const tw = performance.now(); try { env.flushFrames(); } catch (e) { note('flush', e); }
		const n = doc.getElementsByTagName('*').length; if (globalThis.__dbgLoop) { ctx.log(`loop wait ${(tw - ti).toFixed(0)} ms (timer fired after ${(tf - ti).toFixed(0)} ms), flush+count ${(performance.now() - tw).toFixed(0)} ms, elements ${n}, pending rAF ${env.pendingFrames()}`); } if (n === last && !env.pendingFrames()) { stable++; } else { stable = 0; last = n; }
	}
}
export function summarizeRun(ctx, { tImport, tLoaded, done, t00, errors, consoleLog, rssAfterImport, missing, unsupported }) {
	const { doc, log, opt, layoutTiming } = ctx; const r = ctx.rss();
	log(`import ${Math.round(tLoaded - tImport)} ms (RSS ${rssAfterImport.rss} MB after), total until stable ${Math.round(done - t00)} ms, elements ${doc.getElementsByTagName('*').length}, layouts ${doc.__layoutCount} (${Math.round(doc.__layoutMs)} ms incl. style${layoutTiming ? `; native engine pack ${layoutTiming.pack.toFixed(0)} + C ${layoutTiming.native.toFixed(0)} + apply ${layoutTiming.apply.toFixed(0)} ms` : ''}), RSS ${r.rss} MB (peak ${r.peak} MB)`);
	log('missing: ' + JSON.stringify([...missing].sort((a, b) => b[1] - a[1]).slice(0, 25))); log('unsupported: ' + JSON.stringify([...unsupported]));
	const cl = new Map(); for (const [k, m] of consoleLog) { const key = k + ': ' + m.split('\n')[0].slice(0, 220); cl.set(key, (cl.get(key) || 0) + 1); }
	log(`console: ${consoleLog.length} messages, ${cl.size} distinct`); for (const [k, n] of [...cl].filter(([k]) => opt('all', '0') === '1' || /^(error|warn)/.test(k)).slice(0, Number(opt('console', 12)))) { log(`  x${n} ${k}`); }
	summarizePasses(doc, log);
	const seen = new Map(); for (const [k, m] of errors) { const key = k + ': ' + m.split('\n')[0].slice(0, 200); if (!seen.has(key)) { seen.set(key, [0, m]); } seen.get(key)[0]++; }
	log(`errors: ${errors.length} (${seen.size} distinct)`); let shown = 0; for (const [key, [n, m]] of seen) { if (shown++ >= Number(opt('errors', 8))) { break; } log(`  x${n} ${key}\n${m.split('\n').slice(1, 6).join('\n')}`); }
}

/** aggregate of doc.__passStats: how many layout passes, what triggered them, and what a perfect incremental restyle would have saved */
export function summarizePasses(doc, log) {
	const p = doc.__passStats || []; if (!p.length) { return; }
	const sum = (f) => p.reduce((a, x) => a + f(x), 0); const totalMs = sum(x => x.ms), styleMs = sum(x => x.styleMs), layoutMs = sum(x => x.layoutMs);
	log(`layout passes: ${p.length}, ${totalMs.toFixed(0)} ms total (style ${styleMs.toFixed(0)}, layout ${layoutMs.toFixed(0)}); elements per pass min ${Math.min(...p.map(x => x.total))} max ${Math.max(...p.map(x => x.total))}`);
	const est = sum(x => x.restyleEstimate), tot = sum(x => x.total); log(`restyle estimate with perfect invalidation: ${est} element restyles instead of ${tot} (${(100 * est / tot).toFixed(1)} %)`);
	const buckets = [[0, 0], [1, 5], [6, 25], [26, 100], [101, 300], [301, 1e9]]; log('passes by estimated dirty elements: ' + buckets.map(([a, b]) => { const n = p.filter(x => x.restyleEstimate >= a && x.restyleEstimate <= b).length; return `${a}-${b >= 1e9 ? 'max' : b}: ${n}`; }).join(', '));
	const c = {}; for (const x of p) { for (const k in x.counts) { c[k] = (c[k] || 0) + x.counts[k]; } } log('mutations that triggered passes: ' + JSON.stringify(c));
	const textOnly = p.filter(x => x.counts.ins + x.counts.rem + x.counts['attr:class'] + x.counts['attr:style'] + x.counts['attr:other'] === 0).length; log(`passes with no structural/attribute change (text or nothing): ${textOnly}`);
	const worst = [...p].sort((a, b) => b.ms - a.ms).slice(0, 3).map(x => `${x.ms.toFixed(0)} ms (${x.mutations} mutations, est ${x.restyleEstimate}/${x.total})`); log('slowest passes: ' + worst.join('; '));
}
