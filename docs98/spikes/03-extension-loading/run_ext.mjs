// Spike 3 runner: a fake "renderer" for VS Code's extension host running on QuickJS-ng.
//   qjs --stack-size 0 run_ext.mjs <outDir> <extensionsRoot> <settleMs> <extDir>...
// It (1) boots the extension host bundle from <outDir> (made by 02-node-shim/host/gen_shims.mjs), (2) speaks the RPC wire format over a fake
// MessagePort: answers every request the host makes (canned replies, all logged), sends the configuration/workspace initialisation a real
// renderer sends, and (3) passes the given built-in extensions in the init data with autoStart, so the host loads and activates them via require().
import * as std from 'qjs:std';
import * as os from 'qjs:os';
import '../02-node-shim/host/globals.js';

const [outDir, extRoot, settle = '5000', ...extDirs] = scriptArgs.slice(1);
const here = scriptArgs[0].replace(/[^/]*$/, '');
const ids = JSON.parse(std.loadFile(here + 'proxy-ids.json'));
const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const mainById = invert(ids.main), extHostById = invert(ids.extHost);
const u8 = (s) => new TextEncoder().encode(s), str = (b) => new TextDecoder().decode(b);
const t0 = performance.now();

// ---- bootstrap duties of VS Code's own bootstrap --------------------------------------------------------------------------------------------
std.setenv('VSCODE_WILL_SEND_MESSAGE_PORT', '1');
globalThis._VSCODE_NLS_MESSAGES = JSON.parse(std.loadFile(std.getenv('NLS_MESSAGES')));
globalThis._VSCODE_NLS_LANGUAGE = 'en';
os.mkdir('/tmp/spike', 0o777); os.mkdir('/tmp/spike/logs', 0o777); os.mkdir('/tmp/spike/globalStorage', 0o777); os.mkdir('/tmp/spike/workspaceStorage', 0o777);

// ---- preload every Node builtin shim into the table the CommonJS loader reads ---------------------------------------------------------------
const BUILTINS = ['assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream', 'stream/promises', 'string_decoder', 'sys', 'timers', 'timers/promises', 'tls', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib', 'original-fs'];
globalThis.__builtins ??= {};
async function preload() { for (const n of BUILTINS) { try { const ns = await import(`${outDir}/shims/${n.replace(/\//g, '__')}.js`); globalThis.__builtins[n] = ns.default ?? ns; } catch (e) { console.log('preload failed', n, e.message); } } }

// ---- RPC wire format -----------------------------------------------------------------------------------------------------------------------
const w32 = (a, o, v) => { a[o] = v >>> 24; a[o + 1] = v >>> 16; a[o + 2] = v >>> 8; a[o + 3] = v; };
const r32 = (a, o) => ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;
function encodeRequest(req, rpcId, method, args, cancellable) { const m = u8(method), j = u8(JSON.stringify(args)); const b = new Uint8Array(1 + 4 + 1 + 1 + m.length + 4 + j.length); b[0] = cancellable ? 2 : 1; w32(b, 1, req); b[5] = rpcId; b[6] = m.length; b.set(m, 7); w32(b, 7 + m.length, j.length); b.set(j, 11 + m.length); return b; }
function encodeReply(req, value) { if (value === undefined) { const b = new Uint8Array(5); b[0] = 7; w32(b, 1, req); return b; } const j = u8(JSON.stringify(value)); const b = new Uint8Array(9 + j.length); b[0] = 9; w32(b, 1, req); w32(b, 5, j.length); b.set(j, 9); return b; }
function decode(b) {
	const type = b[0], req = r32(b, 1);
	if (type === 1 || type === 2) { const rpcId = b[5], ml = b[6]; const method = str(b.subarray(7, 7 + ml)); const al = r32(b, 7 + ml); let args; try { args = JSON.parse(str(b.subarray(11 + ml, 11 + ml + al))); } catch { args = ['<unparsable>']; } return { kind: 'request', req, rpcId, method, args }; }
	if (type === 3 || type === 4) { const rpcId = b[5], ml = b[6]; const method = str(b.subarray(7, 7 + ml)); let o = 7 + ml; const n = b[o++]; const args = []; for (let i = 0; i < n; i++) { const t = b[o++]; if (t === 1) { const l = r32(b, o); o += 4; args.push(str(b.subarray(o, o + l))); o += l; } else if (t === 2) { const l = r32(b, o); o += 4 + l; args.push('<VSBuffer>'); } else if (t === 3) { const nb = r32(b, o); o += 4; const l = r32(b, o); o += 4; args.push(str(b.subarray(o, o + l))); o += l; for (let k = 0; k < nb; k++) { const bl = r32(b, o); o += 4 + bl; } } else { args.push(undefined); } } return { kind: 'request', req, rpcId, method, args }; }
	if (type === 7) { return { kind: 'reply', req, value: undefined }; }
	if (type === 9) { const l = r32(b, 5); let v; try { v = JSON.parse(str(b.subarray(9, 9 + l))); } catch { v = '<unparsable>'; } return { kind: 'reply', req, value: v }; }
	if (type === 11 || type === 12) { const l = type === 11 ? r32(b, 5) : 0; return { kind: 'error', req, message: type === 11 ? str(b.subarray(9, 9 + l)) : '' }; }
	if (type === 5 || type === 6) { return { kind: 'ack-or-cancel', req }; }
	return { kind: 'other', type, req };
}

// ---- fake renderer ------------------------------------------------------------------------------------------------------------------------
const registrations = {};
const requestLog = new Map();           // "Proxy.$method" -> { count, firstArgs }
const activation = { activated: [], errors: [], consoleMessages: [], timings: {} };
let ready = false, initialized = false, nextReq = 1; const pending = new Map();
const listeners = { message: [] };
const answers = {                        // canned answers, keyed by "MainThreadX.$method"; default is an empty OK reply
	'MainThreadWorkspace.$requestResourceTrust': () => true,
	'MainThreadWindow.$getInitialState': () => ({ isFocused: true, isActive: true }),
	'MainThreadLanguageModelTools.$getTools': () => [],
	'MainThreadExtensionService.$onDidActivateExtension': (a) => { activation.activated.push(a[0] && a[0].value); activation.timings[a[0] && a[0].value] = { codeLoadingMs: Math.round(a[1]), activateCallMs: Math.round(a[2]), activateResolvedMs: Math.round(a[3]) }; },
	'MainThreadExtensionService.$onExtensionActivationError': (a) => { activation.errors.push({ ext: a[0] && a[0].value, error: JSON.stringify(a[1]).slice(0, 1600) }); },
	'MainThreadExtensionService.$onExtensionRuntimeError': (a) => { activation.errors.push({ ext: a[0] && a[0].value, runtime: JSON.stringify(a[1]).slice(0, 1600) }); },
	'MainThreadConsole.$logExtensionHostMessage': (a) => { activation.consoleMessages.push(JSON.stringify(a[0]).slice(0, 300)); },
};
const fakePort = {
	on(ev, fn) { (listeners[ev] ??= []).push(fn); return this; }, once(ev, fn) { return this.on(ev, fn); }, start() { }, close() { },
	postMessage(d) {
		const b = d instanceof Uint8Array ? d : new Uint8Array(d.buffer ?? d);
		if (b.length === 1) { if (b[0] === 2) { ready = true; } if (b[0] === 1) { initialized = true; } return; }
		const m = decode(b);
		if (m.kind === 'request') {
			const name = (mainById[m.rpcId] || ('proxy' + m.rpcId)) + '.' + m.method;
			const e = requestLog.get(name) ?? requestLog.set(name, { count: 0, firstArgs: JSON.stringify(m.args).slice(0, /Error/.test(name) ? 1800 : 200) }).get(name); e.count++;
			if (name.startsWith('MainThreadLanguageFeatures.$register')) { (registrations[name] ??= []).push(m.args); }
			let r; try { r = answers[name] ? answers[name](m.args) : undefined; } catch (err) { r = undefined; }
			Promise.resolve(r).then(v => send(encodeReply(m.req, v)));
		} else if (m.kind === 'reply' || m.kind === 'error') { const p = pending.get(m.req); if (p) { pending.delete(m.req); (m.kind === 'reply' ? p.res : p.rej)(m.kind === 'reply' ? m.value : m.message); } }
	},
};
const send = (bytes) => listeners.message.forEach(f => f({ data: bytes }));
function call(extHostProxy, method, args, cancellable) { const id = ids.extHost[extHostProxy]; const req = nextReq++; return new Promise((res, rej) => { pending.set(req, { res, rej }); send(encodeRequest(req, id, method, args, cancellable)); }); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms) { const end = performance.now() + ms; while (!cond() && performance.now() < end) { await sleep(20); } return cond(); }

const uri = (path) => ({ $mid: 1, scheme: 'file', path, authority: '', query: '', fragment: '' });
function describeExtension(dir) {
	const p = JSON.parse(std.loadFile(`${extRoot}/${dir}/package.json`));
	const id = `${p.publisher || 'vscode'}.${p.name}`;
	return { ...p, publisher: p.publisher || 'vscode', identifier: { value: id, _lower: id.toLowerCase() }, extensionLocation: uri(`${extRoot}/${dir}`), isBuiltin: true, isUserBuiltin: false, isUnderDevelopment: false, targetPlatform: 'undefined', preRelease: false };
}
const emptyModel = { contents: {}, keys: [], overrides: [] };

const dbg = (m) => { if (std.getenv('SPIKE_DEBUG')) { std.err.puts('[' + Math.round(performance.now() - t0) + 'ms] ' + m + '\n'); std.err.flush(); } };
async function main() {
	const result = { extDirs, steps: {}, error: null };
	dbg('preload start'); await preload(); dbg('preload done');
	// Spike 5: with the child_process/net shims (qjs-spike5 host + SHIM_IMPL_DIRS), give the extension host a real process object so extensions can fork servers.
	if (std.getenv('SPIKE5')) { const abs = (p) => p.startsWith('/') ? p : os.getcwd()[0] + '/' + p; const { setupProcess } = await import(abs(here + '../05-child-process/host/proc_setup.mjs')); await setupProcess(outDir, abs(here + '../05-child-process/host/fork_main.mjs'), null, []); }
	const exts = extDirs.map(describeExtension);
	for (const e of exts) { os.mkdir('/tmp/spike/logs/' + e.identifier.value, 0o777); os.mkdir('/tmp/spike/globalStorage/' + e.identifier.value, 0o777); }   // the main thread creates these per extension
	dbg('importing ext host'); await import(outDir + '/bundle/vs/workbench/api/node/extensionHostProcess.js'); dbg('ext host imported');
	await sleep(100);
	(globalThis.__parentPortListeners.get('message') || []).forEach(f => f({ data: undefined, ports: [fakePort] }));
	result.steps.gotReady = await waitFor(() => ready, 3000); dbg('ready=' + ready);
	const activationEvents = Object.fromEntries(exts.map(e => [e.identifier.value, e.activationEvents || []]));
	const wsDir = std.getenv('WORKSPACE');   // spike 5: optional single-folder workspace (git needs one)
	const wsData = wsDir ? { id: 'ws1', name: wsDir.split('/').pop(), folders: [{ uri: uri(wsDir), name: wsDir.split('/').pop(), index: 0 }], configuration: undefined, isUntitled: false, transient: false } : null;
	const cfgContents = std.getenv('CONFIG') ? JSON.parse(std.getenv('CONFIG')) : {};   // spike 5: default settings, e.g. {"git":{"enabled":true}}
	const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) ? flat(v, pre + k + '.') : [pre + k]);
	const emptyModel2 = { contents: cfgContents, keys: flat(cfgContents), overrides: [] };
	const initData = {
		version: '1.142.0', parentPid: 0, autoStart: true,
		environment: { isExtensionDevelopmentDebug: false, appName: 'vscode98', appHost: 'desktop', appRoot: uri(std.getenv('APP_ROOT') || '/home/user/vscode98'), appLanguage: 'en', isExtensionTelemetryLoggingOnly: false, appUriScheme: 'vscode98', globalStorageHome: uri('/tmp/spike/globalStorage'), workspaceStorageHome: uri('/tmp/spike/workspaceStorage') },
		workspace: wsData, extensions: { versionId: 1, allExtensions: exts, activationEvents, myExtensions: exts.map(e => e.identifier) },
		telemetryInfo: { sessionId: 's', machineId: 'm', sqmId: '', devDeviceId: '', firstSessionDate: '' },
		logLevel: Number(std.getenv('LOGLEVEL') || 3), loggers: [], logsLocation: uri('/tmp/spike/logs'),
		remote: { isRemote: false, authority: undefined, connectionData: null }, consoleForward: { includeStack: true, logNative: false }, uiKind: 1,
	};
	send(u8(JSON.stringify(initData)));
	result.steps.gotInitialized = await waitFor(() => initialized, 3000);
	// what a real renderer sends right after Initialized
	result.replies = {};
	call('ExtHostConfiguration', '$initializeConfiguration', [{ defaults: emptyModel2, policy: emptyModel, application: emptyModel, userLocal: emptyModel, userRemote: emptyModel, workspace: emptyModel, folders: [], configurationScopes: [] }]).then(() => { result.replies.initializeConfiguration = 'ok'; }, (e) => { result.replies.initializeConfiguration = 'error: ' + String(e).slice(0, 300); });
	// editor state a real renderer pushes right after init (extensions such as the TypeScript one read window.tabGroups.activeTabGroup immediately)
	call('ExtHostEditorTabs', '$acceptEditorTabModel', [[{ groupId: 1, isActive: true, viewColumn: 0, activeTabId: '', tabs: [] }]]).catch(() => { });
	call('ExtHostWorkspace', '$initializeWorkspace', [wsData, true]).then(() => { result.replies.initializeWorkspace = 'ok'; }, (e) => { result.replies.initializeWorkspace = 'error: ' + String(e).slice(0, 300); });
	// A real renderer fires activation events as they happen (startup finished, a language opened, a command run...). Fire each event the extensions declare.
	await sleep(800);
	const events = [...new Set(['onStartupFinished', ...exts.flatMap(e => e.activationEvents || [])])].filter(ev => ev !== '*' && !ev.startsWith('workspaceContains')).slice(0, 12);
	result.eventsFired = events; result.eventResults = {};
	for (const ev of events) {
		const r = await Promise.race([call('ExtHostExtensionService', '$activateByEvent', [ev, 0]).then(() => 'ok', (e) => 'error: ' + String(e).slice(0, 200)), sleep(8000).then(() => 'timeout')]);
		result.eventResults[ev] = r;
	}
	if (std.getenv('OPEN_DOC')) {   // spike 5: open a JSON document and make the (forked) language server answer through the extension host
		const text = '{\n  "name": "x",\n  "flag": ,\n  "obj": { "a": true, }\n}\n';
		await call('ExtHostDocumentsAndEditors', '$acceptDocumentsAndEditorsDelta', [{ addedDocuments: [{ uri: uri('/tmp/spike/test.json'), versionId: 1, lines: text.split('\n'), EOL: '\n', languageId: 'json', isDirty: false, encoding: 'utf8' }] }]).catch(e => { result.openDocError = String(e).slice(0, 200); });
		const t1 = performance.now();
		result.diagnosticsArrived = await waitFor(() => requestLog.has('MainThreadDiagnostics.$changeMany'), 3000); result.diagnosticsMs = Math.round(performance.now() - t1);
		const handle = (name) => (registrations[name] || [])[0] && registrations[name][0][0];
		const hc = handle('MainThreadLanguageFeatures.$registerCompletionsProvider'), hh = handle('MainThreadLanguageFeatures.$registerHoverProvider'), hs = handle('MainThreadLanguageFeatures.$registerDocumentSymbolProvider');
		const pos = { lineNumber: 3, column: 11 };
		const t2 = performance.now();
		if (hc !== undefined) { const r = await Promise.race([call('ExtHostLanguageFeatures', '$provideCompletionItems', [hc, uri('/tmp/spike/test.json'), pos, { triggerKind: 0 }], true).then(v => v, e => 'error: ' + e), sleep(10000).then(() => 'timeout')]); result.completion = typeof r === 'string' ? r : JSON.stringify(r).slice(0, 400); result.completionMs = Math.round(performance.now() - t2); }
		if (hs !== undefined) { const r = await Promise.race([call('ExtHostLanguageFeatures', '$provideDocumentSymbols', [hs, uri('/tmp/spike/test.json')], true).then(v => v, e => 'error: ' + e), sleep(10000).then(() => 'timeout')]); result.documentSymbols = typeof r === 'string' ? r : (r && r.length); }
		result.diagnosticsSample = (requestLog.get('MainThreadDiagnostics.$changeMany') || {}).firstArgs;
	}
	await sleep(Number(settle));
	const cache = Object.keys(globalThis.__builtins.module._cache);
	result.activated = activation.activated; result.timings = activation.timings; result.activationErrors = activation.errors; result.consoleMessages = activation.consoleMessages.slice(0, 20);
	result.modulesLoadedByRequire = cache.length; result.modulesLoadedSample = cache.slice(0, 40).map(p => p.replace(extRoot, '<ext>'));
	result.rendererRequests = Object.fromEntries([...requestLog].sort((a, b) => b[1].count - a[1].count).map(([k, v]) => [k, { count: v.count, firstArgs: v.firstArgs }]));
	result.stubbedCalls = Object.fromEntries([...globalThis.__stubCalls].map(([k, v]) => [k, { calls: v.calls, firstCaller: v.firstStack.slice(0, 200) }]));
	dbg('replies ' + JSON.stringify(result.replies)); result.totalMs = Math.round(performance.now() - t0);
	std.out.puts(JSON.stringify(result) + '\n'); std.out.flush(); std.exit(0);
}
main().catch(e => { std.out.puts(JSON.stringify({ fatal: String(e && e.message), stack: String(e && e.stack).slice(0, 800) }) + '\n'); std.out.flush(); std.exit(1); });
