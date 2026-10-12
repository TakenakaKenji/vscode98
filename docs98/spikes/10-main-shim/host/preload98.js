// The page-side bridge the real preload.ts builds with Electron's contextBridge: window.vscode = { ipcRenderer, ipcMessagePort, webFrame, webUtils, process, context }.
// `ipc` is the transport to the main process ({ send, invoke, on, off, onceMap... } implemented by the harness).
export function installPreload(win, ipc, { argv, process: proc, readFileSync }) {
	const validateIPC = (channel) => { if (!channel?.startsWith('vscode:')) { throw new Error(`Unsupported event IPC channel '${channel}'`); } return true; };
	const parseArgv = (key) => { for (const arg of argv) { if (arg.indexOf(`--${key}=`) === 0) { return arg.split('=')[1]; } } return undefined; };
	let configuration;
	const resolveConfiguration = (async () => {
		const ch = parseArgv('vscode-window-config'); if (!ch) { throw new Error('Preload: did not find expected vscode-window-config in renderer process arguments list.'); }
		validateIPC(ch);
		const cfg = configuration = await ipc.invoke(ch);
		Object.assign(proc.env, cfg.userEnv);
		return cfg;
	})();
	const resolveShellEnv = (async () => { const [userEnv, shellEnv] = await Promise.all([(async () => (await resolveConfiguration).userEnv)(), ipc.invoke('vscode:fetchShellEnv')]); return { ...proc.env, ...shellEnv, ...userEnv }; })();
	const globals = {
		ipcRenderer: {
			send(channel, ...args) { if (validateIPC(channel)) { ipc.send(channel, ...args); } },
			invoke(channel, ...args) { validateIPC(channel); return ipc.invoke(channel, ...args); },
			on(channel, listener) { validateIPC(channel); ipc.on(channel, listener); return this; },
			once(channel, listener) { validateIPC(channel); ipc.once(channel, listener); return this; },
			removeListener(channel, listener) { validateIPC(channel); ipc.off(channel, listener); return this; },
		},
		ipcMessagePort: {
			acquire(responseChannel, nonce) {
				if (validateIPC(responseChannel)) {
					const responseListener = (e, response) => {
						const responseNonce = typeof response === 'string' ? response : response.nonce;
						if (nonce === responseNonce) { ipc.off(responseChannel, responseListener); win.postMessage(response, '*', e.ports); }
					};
					ipc.on(responseChannel, responseListener);
				}
			},
		},
		webFrame: { setZoomLevel(level) { if (typeof level === 'number') { ipc.webFrameZoom?.(level); } } },
		webUtils: { getPathForFile(file) { return file.path ?? ''; } },
		process: {
			get platform() { return proc.platform; }, get arch() { return proc.arch; }, get env() { return { ...proc.env }; }, get versions() { return proc.versions; }, get type() { return 'renderer'; }, get execPath() { return proc.execPath; },
			cwd() { return proc.env['VSCODE_CWD'] || proc.execPath.substr(0, proc.execPath.lastIndexOf(proc.platform === 'win32' ? '\\' : '/')); },
			shellEnv() { return resolveShellEnv; },
			getProcessMemoryInfo() { return Promise.resolve({ private: 0, residentSet: 0, shared: 0 }); },
			on(type, callback) { },
		},
		context: { configuration() { return configuration; }, async resolveConfiguration() { return resolveConfiguration; } },
	};
	Object.defineProperty(win, 'vscode', { value: globals, writable: false, configurable: true, enumerable: true });
	return globals;
}
