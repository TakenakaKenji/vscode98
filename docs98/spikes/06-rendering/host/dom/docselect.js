// Mouse selection of page text (what a browser does when the user presses and drags over text that is not an <input> or <textarea>): caret on press, extension while dragging,
// word on double click, block on triple click, shift+click extends. The selection itself is document.getSelection() (dom.js); the painter highlights it (paint.js).

/** createDocSelection(doc, env): { start(el, x, y, detail, shift), move(x, y), end(), active } */
export function createDocSelection(doc, env) {
	let drag = null;
	const userSelect = (e) => { const c = env.window.getComputedStyle(e); return c.getPropertyValue('user-select') || c.getPropertyValue('-webkit-user-select') || 'auto'; };
	/** user-select inherits through `auto`: the nearest ancestor with a value other than auto decides */
	const selectable = (el) => { for (let e = el; e; e = e.parentElement) { const v = userSelect(e); if (v && v !== 'auto') { return v !== 'none'; } } return true; };
	const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch);
	const blockOf = (n) => { for (let e = n.parentElement; e; e = e.parentElement) { const d = env.window.getComputedStyle(e).display; if (d && !/^inline($|-(?!block))/.test(d) && d !== 'contents') { return e; } } return doc.body; };
	const caret = (x, y) => { const r = doc.caretRangeFromPoint(x, y); return r ? [r.startContainer, r.startOffset] : null; };
	return {
		get active() { return !!drag; },
		/** a press at (x, y) on el; returns false when the text there cannot be selected */
		start(el, x, y, detail, shift) {
			const sel = doc.__selection; if (!selectable(el)) { return false; } const pos = caret(x, y); if (!pos) { sel.removeAllRanges(); return false; } const [n, o] = pos;
			if (detail >= 3) { const b = blockOf(n.nodeType === 3 ? n : n.parentNode || n); sel.selectAllChildren(b); }
			else if (detail === 2 && n.nodeType === 3) { const t = n.data; let a = o, e = o; while (a > 0 && isWordChar(t[a - 1])) { a--; } while (e < t.length && isWordChar(t[e])) { e++; } if (a === e && o < t.length) { e = o + 1; } sel.setBaseAndExtent(n, a, n, e); }
			else if (shift && sel.rangeCount) { sel.extend(n, o); }
			else { sel.collapse(n, o); }
			drag = { x, y }; return true;
		},
		move(x, y) { if (!drag) { return; } const pos = caret(x, y); if (pos) { doc.__selection.extend(pos[0], pos[1]); } },
		end() { drag = null; },
	};
}
