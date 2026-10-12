// Stand-in for @vscode/policy-watcher (reads Windows group policy / registry): no policy is ever set. The real watcher calls back once with the initial values; the policy service
// waits for that first call before it lets start-up continue, so the stand-in must make it too (with no values).
export function createWatcher(productName, policyDefinitions, onDidChange) { setTimeout(() => onDidChange({}), 0); return { dispose() { } }; }
export default { createWatcher };
