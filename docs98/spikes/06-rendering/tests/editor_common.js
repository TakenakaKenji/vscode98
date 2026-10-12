window.EDITOR_OPTIONS = window.EDITOR_OPTIONS || {};
const text = (window.SAMPLE_TEXT !== undefined) ? window.SAMPLE_TEXT : `// Spike 6 sample
function fib(n: number): number {
\tif (n < 2) { return n; }
\treturn fib(n - 1) + fib(n - 2);
}

const values = [1, 2, 3].map(x => fib(x * 5));
console.log("fib values:", values.join(", "));
`;
window.editor = monaco.editor.create(document.getElementById('container'), Object.assign({
	value: text, language: 'plaintext', theme: 'vs', fontFamily: 'DejaVu Sans Mono', fontSize: 14, lineHeight: 20, minimap: { enabled: false },
	cursorBlinking: 'solid', smoothScrolling: false, automaticLayout: false, renderLineHighlight: 'all', scrollBeyondLastLine: false, fontLigatures: false,
	dimension: { width: 800, height: 520 }, overviewRulerLanes: 0, hideCursorInOverviewRuler: true, guides: { indentation: false }, folding: false, glyphMargin: false,
	lineNumbersMinChars: 3, accessibilitySupport: 'off', scrollbar: { vertical: 'visible', horizontal: 'visible' }, quickSuggestions: false, links: false, occurrencesHighlight: 'off',
	selectionHighlight: false, editContext: false, inlineSuggest: { enabled: false }, lightbulb: { enabled: 'off' }, codeLens: false, hover: { enabled: false }, contextmenu: false, renderWhitespace: 'none', stickyScroll: { enabled: false }, bracketPairColorization: { enabled: false }, matchBrackets: 'never',
}, window.EDITOR_OPTIONS));
if (window.POST) { window.POST(window.editor); }
window.ready = true;
