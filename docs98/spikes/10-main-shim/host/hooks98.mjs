// Module resolution hooks shared by the main process and the utility processes: `electron` -> our stand-in, `original-fs` -> fs, and the Windows-only native packages -> stubs
// (their .node files cannot be loaded; none of them is needed to boot: policies, registry, process trees, mutexes, elevation checks).
import Module from 'node:module';
const WINDOWS_STUBS = { '@vscode/policy-watcher': 'policy-watcher', 'native-is-elevated': 'native-is-elevated', 'windows-foreground-love': 'windows-foreground-love', '@vscode/windows-mutex': 'windows-mutex',
	'@vscode/windows-registry': 'windows-registry', '@vscode/windows-process-tree': 'windows-process-tree', 'native-keymap': 'native-keymap' };
const ALL_STUBS = { 'node-pty': 'node-pty' };   // native addons that cannot load on any platform of this host
export function installResolveHooks(hereUrl) {
	const here = hereUrl.replace(/\/[^/]*$/, '/');
	Module.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === 'electron') { return { url: here + 'electron_stub.mjs', shortCircuit: true }; }
			if (specifier === 'original-fs') { return nextResolve('node:fs', context); }
			if (ALL_STUBS[specifier]) { return { url: here + 'stubs/' + ALL_STUBS[specifier] + '.mjs', shortCircuit: true }; }
			if (process.platform === 'win32' && WINDOWS_STUBS[specifier]) { return { url: here + 'stubs/' + WINDOWS_STUBS[specifier] + '.mjs', shortCircuit: true }; }
			return nextResolve(specifier, context);
		},
	});
}
