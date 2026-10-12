// Stand-in for @vscode/policy-watcher (reads Windows group policy / registry): no policies are ever set.
export async function createWatcher(productName, policyDefinitions, onDidChange) { return { dispose() { } }; }
export default { createWatcher };
