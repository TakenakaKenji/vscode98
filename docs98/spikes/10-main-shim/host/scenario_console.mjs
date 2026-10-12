// prints the renderer console entries matching --grep <regex> (first 8, full text)
export async function run(ctx) {
	const re = new RegExp(ctx.opt('grep', 'FileSystemProviderError')); let n = 0;
	for (const [k, m] of ctx.consoleLog) { if (re.test(m) && n++ < 8) { ctx.log(`console[${k}]: ${m.slice(0, 700)}\n---`); } }
}
