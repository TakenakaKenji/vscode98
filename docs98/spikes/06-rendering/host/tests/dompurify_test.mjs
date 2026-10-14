// Runs the vendored DOMPurify (as the workbench's markdown renderer does) on our DOM and prints what it makes of a settings description.
import * as std from 'qjs:std';
import '../../../02-node-shim/host/globals.js';
import * as opentype from '/home/user/vscode98/node_modules/opentype.js/dist/opentype.mjs';
import '../dom/intl_shim.js';
import { installEnvironment } from '../dom/env.js';
const env = installEnvironment({ width: 800, height: 600, opentype }); const doc = env.document;
const mod = await import('/home/user/vscode98/src/vs/base/browser/dompurify/dompurify.js'); const dompurify = mod.default;
console.log('keys=' + Object.keys(mod) + ' type=' + typeof dompurify + ' dk=' + Object.keys(dompurify).slice(0,12) + ' win=' + typeof globalThis.window + ' docNodeType=' + (globalThis.window && window.document && window.document.nodeType));
const html = '<p>Controls the font size in pixels. <a href="#editor.fontSize" title="editor.fontSize" draggable="false">Editor: Font Size</a> is used.</p>';
const cfg = { ALLOWED_TAGS: ['p', 'a', 'code', 'b'], ALLOWED_ATTR: ['href', 'title', 'draggable'], RETURN_DOM_FRAGMENT: true };
dompurify.addHook('uponSanitizeElement', (node, data) => { console.log('hook element tag=' + data.tagName + ' allowed=' + !!data.allowedTags[data.tagName]); });
console.log('isSupported=' + dompurify.isSupported); const frag = dompurify.sanitize(html, cfg); console.log('frag type=' + typeof frag + ' ctor=' + (frag && frag.constructor && frag.constructor.name) + ' val=' + String(frag).slice(0, 80));
const out = []; const walk = (n, d) => { for (const c of n.childNodes) { out.push(' '.repeat(d) + (c.nodeType === 1 ? '<' + c.localName + '>' : JSON.stringify(c.textContent.slice(0, 40)))); if (c.nodeType === 1) { walk(c, d + 1); } } }; walk(frag, 0);
console.log(out.join('\n'));
