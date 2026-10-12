// Node loader hooks of the renderer harness: vscode-file://vscode-app/<abs path> -> file:///<abs path> (how Electron's protocol handler serves the app's files).
export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith('vscode-file://vscode-app/')) { return { url: 'file://' + specifier.slice('vscode-file://vscode-app'.length), shortCircuit: true }; }
	return nextResolve(specifier, context);
}
