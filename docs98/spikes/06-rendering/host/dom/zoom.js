// Page zoom (Ctrl +/-, window.zoomLevel): the page is laid out in a viewport of (window size / factor) CSS pixels and painted scaled by the factor, as a browser does. The window
// host (or a test rig) sets `onChange` to resize the document; the paint path wraps its backend in a ScaledBackend.
export const zoom = {
	factor: 1, level: 0, onChange: null,
	/** Electron's zoom levels: factor = 1.2 ** level (clamped to 25 % .. 500 %) */
	set(level) { const l = Math.max(-7.6, Math.min(8.8, Number(level) || 0)); const f = Math.round(1.2 ** l * 1000) / 1000; this.level = l; if (f !== this.factor) { this.factor = f; this.onChange?.(f); } },
};
globalThis.__zoom98 = zoom;

/** a drawing backend that scales everything by z (wraps NativeBackend / JsBackend) */
export class ScaledBackend {
	constructor(backend, z) { this.b = backend; this.z = z; }
	get stats() { return this.b.stats; }
	fillRect(x, y, w, h, color, alphaMul = 1) { const z = this.z; this.b.fillRect(x * z, y * z, w * z, h * z, color, alphaMul); }
	fillRoundRect(x, y, w, h, radii, color, alphaMul = 1) { const z = this.z; this.b.fillRoundRect(x * z, y * z, w * z, h * z, radii && radii.map((r) => r * z), color, alphaMul); }
	pushClip(x0, y0, x1, y1) { const z = this.z; this.b.pushClip(x0 * z, y0 * z, x1 * z, y1 * z); }
	popClip() { this.b.popClip(); } resetClip() { this.b.resetClip(); } pushLayer() { this.b.pushLayer(); } popLayer(alpha) { this.b.popLayer(alpha); }
	glyphRun(font, size, ls, wsp, x, by, color, alphaMul, text) { const z = this.z; this.b.glyphRun(font, size * z, ls * z, wsp * z, x * z, by * z, color, alphaMul, text); }
	reset() { this.b.reset?.(); } finish() { return this.b.finish(); }
}
