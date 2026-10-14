// <select> and <option>: the option collection (options.length = 0, add, remove, item), selectedIndex/value/selectedOptions, option.selected/value/text/index.
// Selectedness lives in option.__selected (undefined: the `selected` attribute); a single-choice select with nothing selected shows its first enabled option.
import { touchPaint } from './textmodel.js';

/** the <option> elements of a select, in order (those inside an <optgroup> included) */
export function optionList(sel) {
	const out = []; for (const c of sel.__children) { if (c.nodeType !== 1) { continue; } if (c.localName === 'option') { out.push(c); } else if (c.localName === 'optgroup') { for (const o of c.__children) { if (o.nodeType === 1 && o.localName === 'option') { out.push(o); } } } }
	return out;
}
const isSelected = (o) => (o.__selected !== undefined ? o.__selected : o.hasAttribute('selected'));
function selectedIndexOf(sel) {
	const list = optionList(sel); const i = list.findIndex(isSelected); if (i >= 0 || sel.hasAttribute('multiple')) { return i; }
	return list.findIndex((o) => !o.hasAttribute('disabled'));   // display default of a single-choice select
}
function selectIndex(sel, idx) {
	const list = optionList(sel); const multiple = sel.hasAttribute('multiple');
	for (let i = 0; i < list.length; i++) { const on = i === idx; if (multiple && !on) { continue; } if (list[i].__selected !== on) { list[i].__selected = on; } }
	touchPaint(sel);
}
/** the collection behind select.options: array-like, with a settable length and the HTMLOptionsCollection methods */
function optionsCollection(sel) {
	const methods = {
		item: (i) => optionList(sel)[i] ?? null, namedItem: (n) => optionList(sel).find((o) => o.id === n || o.getAttribute('name') === n) ?? null,
		add: (o, before) => sel.add(o, before), remove: (i) => sel.remove(i), get selectedIndex() { return selectedIndexOf(sel); }, set selectedIndex(v) { selectIndex(sel, v); },
	};
	const arrayMethods = new Set(['forEach', 'map', 'filter', 'find', 'findIndex', 'some', 'every', 'indexOf', 'slice', 'includes', 'reduce', 'entries', 'keys', 'values']);
	return new Proxy([], {
		get(_, k) {
			if (k === 'length') { return optionList(sel).length; } if (typeof k === 'string' && /^\d+$/.test(k)) { return optionList(sel)[+k]; }
			if (k === Symbol.iterator) { return () => optionList(sel)[Symbol.iterator](); } if (k in methods) { return methods[k]; }
			if (arrayMethods.has(k)) { return (...a) => optionList(sel)[k](...a); } if (k === Symbol.toStringTag) { return 'HTMLOptionsCollection'; } return undefined;
		},
		set(_, k, v) {
			if (k === 'length') { const list = optionList(sel); const n = Math.max(0, v | 0); for (let i = list.length - 1; i >= n; i--) { list[i].remove(); } for (let i = list.length; i < n; i++) { sel.appendChild(sel.ownerDocument.createElement('option')); } return true; }
			if (k === 'selectedIndex') { selectIndex(sel, v); return true; }
			if (typeof k === 'string' && /^\d+$/.test(k)) { const list = optionList(sel); if (v === null || v === undefined) { if (list[+k]) { list[+k].remove(); } } else if (list[+k]) { list[+k].parentNode.replaceChild(v, list[+k]); } else { sel.appendChild(v); } return true; }
			return true;
		},
		has(_, k) { return k === 'length' || k in methods || (typeof k === 'string' && /^\d+$/.test(k) && +k < optionList(sel).length); },
		ownKeys() { return [...optionList(sel).keys()].map(String).concat('length'); },
		getOwnPropertyDescriptor(_, k) { if (k === 'length') { return { value: optionList(sel).length, writable: true, enumerable: false, configurable: false }; } if (typeof k === 'string' && /^\d+$/.test(k) && +k < optionList(sel).length) { return { value: optionList(sel)[+k], writable: true, enumerable: true, configurable: true }; } return undefined; },
	});
}
export const selectProps = {
	get options() { return optionsCollection(this); },
	get length() { return optionList(this).length; }, set length(v) { this.options.length = v; },
	get selectedIndex() { return selectedIndexOf(this); }, set selectedIndex(v) { selectIndex(this, v | 0); },
	get selectedOptions() { const list = optionList(this); const i = selectedIndexOf(this); return this.hasAttribute('multiple') ? list.filter(isSelected) : (i >= 0 ? [list[i]] : []); },
	get value() { const i = selectedIndexOf(this); return i >= 0 ? optionList(this)[i].value : ''; },
	set value(v) { const list = optionList(this); const i = list.findIndex((o) => o.value === String(v)); selectIndex(this, i); },
	get multiple() { return this.hasAttribute('multiple'); }, set multiple(v) { v ? this.setAttribute('multiple', '') : this.removeAttribute('multiple'); },
	get size() { const s = parseInt(this.getAttribute('size') ?? '', 10); return Number.isNaN(s) ? (this.hasAttribute('multiple') ? 4 : 1) : s; }, set size(v) { this.setAttribute('size', v); },
	get type() { return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one'; },
	get disabled() { return this.hasAttribute('disabled'); }, set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); },
	get form() { for (let p = this.parentElement; p; p = p.parentElement) { if (p.localName === 'form') { return p; } } return null; },
	get labels() { return []; }, get __tcSelect() { return true; },
	item(i) { return optionList(this)[i] ?? null; }, namedItem(n) { return optionList(this).find((o) => o.id === n) ?? null; },
	add(option, before) { const ref = typeof before === 'number' ? optionList(this)[before] ?? null : before ?? null; (ref && ref.parentNode ? ref.parentNode : this).insertBefore(option, ref); },
	remove(i) { if (i === undefined) { Element_remove(this); return; } const o = optionList(this)[i]; if (o) { o.remove(); } },
	checkValidity() { return true; }, reportValidity() { return true; }, setCustomValidity() { }, get validity() { return { valid: true }; }, get willValidate() { return true; },
};
function Element_remove(el) { if (el.parentNode) { el.parentNode.removeChild(el); } }
export const optionProps = {
	get selected() { return isSelected(this); }, set selected(v) { const sel = optionSelect(this); if (sel && !sel.hasAttribute('multiple') && v) { for (const o of optionList(sel)) { if (o !== this) { o.__selected = false; } } } this.__selected = !!v; touchPaint(this); },
	get defaultSelected() { return this.hasAttribute('selected'); }, set defaultSelected(v) { v ? this.setAttribute('selected', '') : this.removeAttribute('selected'); },
	get value() { return this.hasAttribute('value') ? this.getAttribute('value') : this.text; }, set value(v) { this.setAttribute('value', v); },
	get text() { return this.textContent.replace(/[\t\n\f\r ]+/g, ' ').trim(); }, set text(v) { this.textContent = v; },
	get label() { return this.hasAttribute('label') ? this.getAttribute('label') : this.text; }, set label(v) { this.setAttribute('label', v); },
	get index() { const sel = optionSelect(this); return sel ? optionList(sel).indexOf(this) : 0; },
	get disabled() { return this.hasAttribute('disabled'); }, set disabled(v) { v ? this.setAttribute('disabled', '') : this.removeAttribute('disabled'); },
	get form() { const s = optionSelect(this); return s ? s.form : null; },
};
function optionSelect(o) { for (let p = o.parentNode; p; p = p.parentNode) { if (p.localName === 'select') { return p; } } return null; }
