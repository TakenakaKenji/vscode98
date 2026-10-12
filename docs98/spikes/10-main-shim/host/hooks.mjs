// Node ESM loader hooks for the discovery runs: `electron` resolves to our stub.
export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'electron') { return { url: new URL('./electron_stub.mjs', import.meta.url).href, shortCircuit: true }; }
	if (specifier === 'original-fs') { return nextResolve('node:fs', context); }
	return nextResolve(specifier, context);
}
