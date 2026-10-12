// Ground truth from real Chromium (Playwright's bundled headless shell): screenshot + every element's box and key computed style + the DOM.
//   node chromium_truth.mjs <monacoDir> <outPrefix> [pageHtml]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const { chromium } = createRequire(import.meta.url)('/home/user/vscode98/node_modules/playwright-core');
const [monacoDir, outPrefix, pageArg] = process.argv.slice(2);
const page_ = path.resolve(pageArg || path.join(import.meta.dirname, 'page.html'));
fs.copyFileSync(page_, path.join(monacoDir, 'page.html'));
const exe = process.env.CHROMIUM || fs.readdirSync('/opt/pw-browsers').filter(d => d.startsWith('chromium_headless_shell')).map(d => `/opt/pw-browsers/${d}/chrome-linux/headless_shell`)[0];
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--font-render-hinting=none', '--disable-lcd-text', '--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 800, height: 520 }, deviceScaleFactor: 1 });
page.on('pageerror', e => console.error('pageerror', e.message));
await page.goto('file://' + path.join(monacoDir, 'page.html'));
await page.waitForFunction('window.ready === true');
await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(500);
const dump = await page.evaluate(() => {
	const props = ['display', 'position', 'visibility', 'overflow', 'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'whiteSpace', 'opacity', 'zIndex', 'cursor', 'pointerEvents', 'borderTopWidth', 'transform', 'contain', 'boxSizing'];
	const out = [];
	const walk = (el, depth, path) => {
		const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
		const style = {}; for (const p of props) { style[p] = cs[p]; }
		out.push({ path, tag: el.tagName.toLowerCase(), cls: el.getAttribute('class') || '', id: el.id || '', x: r.x, y: r.y, w: r.width, h: r.height, depth, text: el.children.length === 0 ? el.textContent.slice(0, 80) : undefined, style, offsetW: el.offsetWidth, offsetH: el.offsetHeight, scrollW: el.scrollWidth, scrollH: el.scrollHeight, inlineStyle: el.getAttribute('style') || '' });
		let i = 0; for (const c of el.children) { walk(c, depth + 1, path + '/' + c.tagName.toLowerCase() + '[' + (i++) + ']'); }
	};
	walk(document.getElementById('container'), 0, 'container');
	return { elements: out, html: document.getElementById('container').outerHTML, styleSheets: document.styleSheets.length, fontCheck: [...document.fonts].map(f => f.family + ':' + f.status) };
});
await page.screenshot({ path: outPrefix + '.png' });
fs.writeFileSync(outPrefix + '.json', JSON.stringify(dump, null, 1));
console.log('elements', dump.elements.length, 'html bytes', dump.html.length, 'styleSheets', dump.styleSheets);
await browser.close();
