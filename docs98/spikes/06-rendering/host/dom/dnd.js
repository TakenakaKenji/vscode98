// HTML5 drag and drop driven by the mouse: a press on a draggable="true" element followed by a few pixels of movement starts a drag (dragstart; canceled = no drag), the
// pointer then produces dragenter/dragover/dragleave on the element under it instead of mouse events, and the release is a drop (when the last dragover was canceled, i.e. the
// target accepts the drop) and a dragend on the source. There is no drag image; DataTransfer is the in-memory one of textcontrol.js.
import { dataTransfer } from './textcontrol.js';

const THRESHOLD = 4;
/** createDnd(ctx, { at, dispatch }): { arm(el, x, y), move(x, y, mods), up(x, y, mods), active } */
export function createDnd(ctx, { at, dispatch }) {
	const { env } = ctx; let armed = null, session = null;
	const DE = (type, x, y, dt, mods, extra = {}) => new env.window.DragEvent(type, { bubbles: true, cancelable: true, composed: true, view: env.window, clientX: x, clientY: y, screenX: x, screenY: y, ctrlKey: !!(mods & 2), shiftKey: !!(mods & 1), altKey: !!(mods & 4), metaKey: !!(mods & 8), dataTransfer: dt, ...extra });
	return {
		get active() { return !!session; },
		arm(el, x, y) { armed = null; for (let e = el; e; e = e.parentElement) { if (e.getAttribute && e.getAttribute('draggable') === 'true') { armed = { src: e, x, y }; return; } } },
		/** a pointer move with the primary button down; true when the drag consumed it (no mouse events then) */
		move(x, y, mods) {
			if (!session) {
				if (!armed || Math.hypot(x - armed.x, y - armed.y) < THRESHOLD) { return false; }
				const dt = dataTransfer(); const src = armed.src; armed = null; if (!dispatch(src, DE('dragstart', x, y, dt, mods))) { return false; }
				session = { src, dt, over: null, accepted: false };
			}
			const t = at(x, y), s = session;
			if (t !== s.over) { const prev = s.over; s.over = t; dispatch(t, DE('dragenter', x, y, s.dt, mods, { relatedTarget: prev })); if (prev) { dispatch(prev, DE('dragleave', x, y, s.dt, mods, { relatedTarget: t })); } }
			s.accepted = !dispatch(t, DE('dragover', x, y, s.dt, mods)); return true;
		},
		/** the button was released; true when a drag was running */
		up(x, y, mods) {
			armed = null; if (!session) { return false; } const s = session; session = null; const t = at(x, y);
			if (s.accepted) { s.dt.dropEffect = s.dt.dropEffect === 'none' ? 'move' : s.dt.dropEffect; dispatch(t, DE('drop', x, y, s.dt, mods)); } else { s.dt.dropEffect = 'none'; if (s.over) { dispatch(s.over, DE('dragleave', x, y, s.dt, mods)); } }
			dispatch(s.src, DE('dragend', x, y, s.dt, mods)); return true;
		},
	};
}
