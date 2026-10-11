// Diagnoses the markdown-preview webview: frame structure, console/network errors, inner-frame DOM + CSS census.
// Usage (via run_scenarios.sh): bash docs98/inventory/scripts/run_scenarios.sh <workdir> 9333 trace_webview.mjs
import CDP from 'chrome-remote-interface';
import { writeFileSync, mkdirSync } from 'node:fs';
import { CENSUS } from './trace_common.mjs';
import { makeInput } from './cdp_input.mjs';

const [port = '9333', out = 'webview-trace.json', shotsDir = 'shots'] = process.argv.slice(2);
mkdirSync(shotsDir, { recursive: true });
let target;
for (let i = 0; i < 90 && !target; i++) { try { target = (await CDP.List({ port: Number(port) })).find(t => t.type === 'page' && /workbench/.test(t.url)); } catch { /* wait */ } if (!target) { await new Promise(r => setTimeout(r, 1000)); } }
if (!target) { console.error('no workbench target'); process.exit(2); }
const client = await CDP({ port: Number(port), target });
const { Page, Runtime, Emulation } = client;
const { sleep, ev, waitFor, press, typeText, click } = makeInput(client);
await Page.enable(); await Runtime.enable();
await Emulation.setDeviceMetricsOverride({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await Emulation.setFocusEmulationEnabled({ enabled: true });

const log = []; // console + network + exception events from every session
client.on('event', (m) => {
	const where = m.sessionId ? 'child' : 'page';
	if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) { log.push({ where, kind: 'console.' + m.params.type, text: m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300) }); }
	if (m.method === 'Runtime.exceptionThrown') { log.push({ where, kind: 'exception', text: (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 400) }); }
	if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) { log.push({ where, kind: 'log.' + m.params.entry.level, text: (m.params.entry.text + ' ' + (m.params.entry.url ?? '')).slice(0, 300) }); }
	if (m.method === 'Network.loadingFailed') { log.push({ where, kind: 'net.failed', text: `${m.params.errorText} ${m.params.blockedReason ?? ''}`.slice(0, 200) }); }
	if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) { log.push({ where, kind: 'net.http' + m.params.response.status, text: m.params.response.url.slice(0, 200) }); }
});
await client.send('Log.enable'); await client.send('Network.enable');

await waitFor(`!!document.querySelector('.monaco-workbench .part.editor') && document.querySelectorAll('.monaco-workbench .statusbar-item').length > 0`, 90000);
await sleep(8000); await click(745, 300); await sleep(500);
// open README.md, then Markdown: Show Preview
await press('ctrl+p'); await sleep(500); await typeText('README.md'); await sleep(900); await press('enter'); await sleep(1500);
await press('ctrl+shift+v');
const result = { takenAt: new Date().toISOString(), samples: [] };

// sample the webview several times to see whether it ever renders
for (const waitMs of [3000, 5000, 10000, 15000]) {
	await sleep(waitMs - (result.samples.at(-1)?.t ?? 0));
	const s = { t: waitMs };
	s.mainPage = await ev(`(() => { const f = document.querySelector('iframe'); const w = f?.closest('.webview, .webview-container, [class*=webview]'); const r = f?.getBoundingClientRect(); const cs = f && getComputedStyle(f); const pcs = w && getComputedStyle(w);
		return { iframeCount: document.querySelectorAll('iframe').length, iframe: f ? { src: (f.getAttribute('src') ?? '').slice(0, 140), sandbox: f.getAttribute('sandbox'), allow: f.getAttribute('allow'), rect: [r.x, r.y, r.width, r.height].map(Math.round), visibility: cs.visibility, display: cs.display, opacity: cs.opacity, pointerEvents: cs.pointerEvents } : null,
		wrapperClass: w?.className ?? null, wrapperVisibility: pcs?.visibility ?? null, wrapperDisplay: pcs?.display ?? null, wrapperOpacity: pcs?.opacity ?? null, activeTab: document.querySelector('.tab.active')?.textContent ?? null }; })()`);
	const { targetInfos } = await client.send('Target.getTargets');
	s.targets = targetInfos.map(t => ({ type: t.type, url: t.url.slice(0, 120), attached: t.attached }));
	result.samples.push(s);
	console.error('sample', waitMs, JSON.stringify(s.mainPage.iframe));
}

// attach to the webview shell frame and inspect inside
const { targetInfos } = await client.send('Target.getTargets');
const shell = targetInfos.find(t => t.type === 'iframe' && /vscode-webview/.test(t.url));
result.shellTarget = shell ? { url: shell.url.slice(0, 160) } : null;
if (shell) {
	const { sessionId } = await client.send('Target.attachToTarget', { targetId: shell.targetId, flatten: true });
	const send = (method, params) => client.send(method, params, sessionId);
	await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Page.enable');
	await sleep(1500);
	const evalIn = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true }); return r.exceptionDetails ? { error: (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300) } : r.result.value; };
	try { result.frameTree = JSON.stringify((await send('Page.getFrameTree')).frameTree, (k, v) => (['url', 'securityOrigin', 'name', 'childFrames', 'frame', 'id', 'mimeType'].includes(k) || /^\d+$/.test(k) || Array.isArray(v) || typeof v === 'object') ? (typeof v === 'string' ? v.slice(0, 140) : v) : undefined).slice(0, 1500); } catch (e) { result.frameTree = 'error ' + e.message; }
	result.shellInfo = await evalIn(`(() => { const f = document.querySelector('iframe'); let inner = null; try { inner = f && f.contentDocument ? 'accessible' : 'null'; } catch (e) { inner = 'blocked: ' + e.message; }
		return { shellBodyHTML: document.body.innerHTML.slice(0, 700), iframeSrc: (f?.getAttribute('src') ?? '').slice(0, 200), iframeSandbox: f?.getAttribute('sandbox'), innerDoc: inner, readyState: document.readyState, hasServiceWorker: !!navigator.serviceWorker, swController: !!navigator.serviceWorker?.controller }; })()`);
	result.inner = await evalIn(`(() => { const f = document.querySelector('iframe'); if (!f || !f.contentDocument) { return { note: 'no accessible inner document' }; } const d = f.contentDocument;
		return { readyState: d.readyState, elements: d.getElementsByTagName('*').length, textHead: (d.body?.innerText ?? '').slice(0, 300), htmlLen: d.documentElement.outerHTML.length, headHTML: d.head.innerHTML.slice(0, 600), bodyClass: d.body?.className, styleSheets: d.styleSheets.length, viewport: [f.contentWindow.innerWidth, f.contentWindow.innerHeight] }; })()`);
	// The page CSP forbids eval, so run the census in an isolated world of the inner frame (not subject to the page CSP).
	try {
		const tree = (await send('Page.getFrameTree')).frameTree; const child = tree.childFrames?.[0]?.frame;
		if (!child) { result.innerCensus = { error: 'no child frame in frame tree' }; }
		else {
			const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: child.id, worldName: 'census', grantUniveralAccess: true });
			const r = await send('Runtime.evaluate', { expression: CENSUS, contextId: executionContextId, returnByValue: true });
			result.innerCensus = r.exceptionDetails ? { error: (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300) } : r.result.value;
			result.innerFrameUrl = child.url.slice(0, 120);
		}
	} catch (e) { result.innerCensus = { error: String(e.message ?? e).slice(0, 300) }; }
	try { writeFileSync(`${shotsDir}/webview-shell.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); result.shellScreenshot = 'ok'; } catch (e) { result.shellScreenshot = 'failed: ' + String(e.message).slice(0, 120); }
}
writeFileSync(`${shotsDir}/main-after-preview.png`, Buffer.from((await Page.captureScreenshot({ format: 'png' })).data, 'base64'));
result.log = log.slice(0, 80); result.logTotal = log.length;
writeFileSync(out, JSON.stringify(result, null, 1));
console.error('wrote', out, 'log entries', log.length);
await client.close(); process.exit(0);
