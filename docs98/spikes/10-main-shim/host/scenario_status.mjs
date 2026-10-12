// prints the status bar items and the activity bar badges after boot (git extension => branch name in the status bar if the extension host works)
export async function run(ctx) {
	const { doc, log } = ctx;
	for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 5000)); const items = [...doc.querySelectorAll('.statusbar-item')].map(e => (e.textContent || '').trim()).filter(Boolean); log(`status bar after ${(i + 1) * 5}s: ${JSON.stringify(items)}`); if (items.some(t => /main|master/.test(t))) { break; } }
	log('activity bar: ' + JSON.stringify([...doc.querySelectorAll('.activitybar .action-label')].map(e => e.getAttribute('aria-label'))));
}
