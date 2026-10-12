// Spike 2b runner:  qjs --stack-size 0 run_entry.mjs <outDir (from gen_shims.mjs)> <entry.js> [settleMs]
// Evaluates one Node-side bundle on QuickJS with the generated shims, waits `settleMs` for timers/microtasks, then prints the result as JSON:
// whether top-level evaluation finished, the first exception (if any), and which stubbed (= unimplemented) APIs were called.
import * as std from 'qjs:std';
import './globals.js';

const [outDir, entry, settle = '3000'] = scriptArgs.slice(1);
// Bootstrap duty normally done by VS Code's bootstrap-esm: the --nls build reads its strings from globalThis._VSCODE_NLS_MESSAGES.
std.setenv('VSCODE_WILL_SEND_MESSAGE_PORT', '1');
const nlsFile = (std.getenv('NLS_MESSAGES') || '/home/user/vscode98/out-vscode-min/nls.messages.json');
globalThis._VSCODE_NLS_MESSAGES = JSON.parse(std.loadFile(nlsFile));
globalThis._VSCODE_NLS_LANGUAGE = 'en';
const t0 = performance.now();
// NOTE: no top-level await. With TLA, `qjs` waits for the main module via js_std_await, which runs ONE pending job per iteration and then polls timers,
// so every promise continuation in the bundle would be gated on a timer wake-up. Running main() un-awaited lets js_std_loop drain jobs normally.
async function main() {
let result = { entry, evaluated: false, error: null };
	try {
		await import(outDir + '/bundle/' + entry);
		result.evaluated = true;
	} catch (e) {
		result.error = { message: String(e && e.message), stack: String(e && e.stack).split('\n').slice(0, 8).join('\n') };
	}
	result.evalMs = Math.round(performance.now() - t0);
	// If the bundle is waiting for a renderer MessagePort on process.parentPort, hand it a fake one and record what it sends back.
	const portLog = [];
	const fakePort = { _l: {}, on(ev, fn) { (this._l[ev] ??= []).push(fn); return this; }, once(ev, fn) { return this.on(ev, fn); }, start() { }, close() { },
		postMessage(d) { const u = d instanceof Uint8Array ? d : new Uint8Array(d.buffer ?? d); portLog.push({ bytes: u.length, head: Array.from(u.slice(0, 16)), ascii: new TextDecoder().decode(u.slice(0, 900)).replace(/[^\x20-\x7e]/g, '.'), t: Math.round(performance.now() - t0) }); } };
	await new Promise(r => setTimeout(r, 300));
	const pl = globalThis.__parentPortListeners.get('message');
	result.waitingForParentPortMessage = !!pl;
	if (pl) {
		if (std.getenv('SPIKE_DEBUG')) { queueMicrotask(() => console.log('RUNENTRY microtask 1')); for (const ms of [0, 50, 200]) { setTimeout(() => console.log('RUNENTRY timer ' + ms), ms); } }
		pl.forEach(f => f({ data: undefined, ports: [fakePort] }));
	if (std.getenv('INITDATA')) {
		await new Promise(r => setTimeout(r, 400));          // let the host send Ready first
		const uri = (path) => ({ $mid: 1, scheme: 'file', path, authority: '', query: '', fragment: '' });
		const initData = {
			version: '1.142.0', parentPid: 0,
			environment: { isExtensionDevelopmentDebug: false, appName: 'vscode98', appHost: 'desktop', appRoot: uri('/tmp/app'), appLanguage: 'en', isExtensionTelemetryLoggingOnly: false, appUriScheme: 'vscode98', globalStorageHome: uri('/tmp/spike/globalStorage'), workspaceStorageHome: uri('/tmp/spike/workspaceStorage') },
			workspace: null, extensions: { versionId: 1, allExtensions: [], activationEvents: {}, myExtensions: [] },
			telemetryInfo: { sessionId: 's', machineId: 'm', sqmId: '', devDeviceId: '', firstSessionDate: '' },
			logLevel: 3, loggers: [], logsLocation: uri('/tmp/spike/logs'), autoStart: false,
			remote: { isRemote: false, authority: undefined, connectionData: null }, consoleForward: { includeStack: false, logNative: false }, uiKind: 1,
		};
		const bytes = new TextEncoder().encode(JSON.stringify(initData));
		(fakePort._l.message || []).forEach(f => f({ data: bytes }));
		result.initDataSent = true;
	}
		if (std.getenv('SPIKE_DEBUG')) { console.log('RUNENTRY delivered port'); }
	}
	setTimeout(() => {
		const calls = {};
		for (const [k, v] of globalThis.__stubCalls) { calls[k] = { calls: v.calls, firstCaller: v.firstStack }; }
		result.stubbedCalls = calls; result.stubbedCallCount = Object.keys(calls).length;
		result.processListeners = [...globalThis.__processListeners.keys()];
		result.portMessagesFromBundle = portLog.slice(0, 400); result.portMessageCount = portLog.length; result.portListenersRegistered = Object.keys(fakePort._l);
		result.totalMs = Math.round(performance.now() - t0);
		std.out.puts(JSON.stringify(result) + '\n'); std.out.flush();
		std.exit(0);
	}, Number(settle));
}
main();
