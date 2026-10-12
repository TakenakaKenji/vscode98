// JavaScript stand-ins for the native Node addons (.node files) VS Code's Node-side code loads. Not real implementations: a JSON-file backed emulation of the one SQL subset
// @vscode/sqlite3 is used for (the key/value ItemTable of the storage service) and a polling replacement for @parcel/watcher. Unknown addons get a lenient stub.
// Hooked in through globalThis.__loadNativeAddon, called by the Module shim (02-node-shim/host/impl/module.js) for every `.node` file.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';

// ------------------------------------------------------------------------------------------------------------------------------------ sqlite3
const tick = (fn) => setTimeout(fn, 0);
function makeSqlite() {
	const stores = new Map();   // file -> { items: Map, dirty }
	const openStore = (file) => {
		let st = stores.get(file); if (st) { return st; }
		st = { file, items: new Map(), tx: false }; stores.set(file, st);
		if (file !== ':memory:' && file !== '') {
			try { const j = JSON.parse(fs.readFileSync(file + '.json', 'utf8')); for (const [k, v] of Object.entries(j)) { st.items.set(k, v); } } catch { /* new or unreadable: start empty (the real .vscdb is a binary SQLite file we do not read) */ }
		}
		return st;
	};
	const persist = (st) => { if (st.file === ':memory:' || st.file === '') { return; } try { fs.mkdirSync(path.dirname(st.file), { recursive: true }); fs.writeFileSync(st.file + '.json', JSON.stringify(Object.fromEntries(st.items))); } catch (e) { /* ignore */ } };
	const flat = (sql) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
	const unsupported = (sql) => Object.assign(new Error(`SQLITE_ERROR: unsupported statement in the emulation: ${sql.slice(0, 80)}`), { code: 'SQLITE_ERROR', errno: 1 });
	/** executes one statement; returns { rows, changes } */
	function execOne(st, sqlIn, params) {
		const sql = flat(sqlIn); let m;
		if (sql === '') { return { rows: [], changes: 0 }; }
		if (/^PRAGMA (integrity_check|quick_check)/i.test(sql)) { return { rows: [{ integrity_check: 'ok', quick_check: 'ok' }], changes: 0 }; }
		if (/^PRAGMA /i.test(sql) || /^VACUUM$/i.test(sql)) { return { rows: [], changes: 0 }; }
		if (/^CREATE TABLE IF NOT EXISTS ItemTable/i.test(sql)) { return { rows: [], changes: 0 }; }
		if (/^(BEGIN|SAVEPOINT)\b/i.test(sql)) { st.tx = true; return { rows: [], changes: 0 }; }
		if (/^(END|COMMIT|RELEASE)\b/i.test(sql)) { st.tx = false; persist(st); return { rows: [], changes: 0 }; }
		if (/^ROLLBACK\b/i.test(sql)) { st.tx = false; return { rows: [], changes: 0 }; }
		if (/^SELECT \* FROM ItemTable$/i.test(sql)) { return { rows: [...st.items].map(([key, value]) => ({ key, value })), changes: 0 }; }
		if ((m = /^SELECT value FROM ItemTable WHERE key = \?$/i.exec(sql))) { return { rows: st.items.has(params[0]) ? [{ value: st.items.get(params[0]) }] : [], changes: 0 }; }
		if (/^INSERT (OR REPLACE )?INTO ItemTable VALUES/i.test(sql)) { let n = 0; for (let i = 0; i + 1 < params.length; i += 2) { const k = params[i], v = params[i + 1]; if (st.items.get(k) !== v) { st.items.set(k, v); n++; } } if (!st.tx) { persist(st); } return { rows: [], changes: n }; }
		if (/^DELETE FROM ItemTable WHERE key IN/i.test(sql)) { let n = 0; for (const k of params) { if (st.items.delete(k)) { n++; } } if (!st.tx) { persist(st); } return { rows: [], changes: n }; }
		throw unsupported(sql);
	}
	const splitSql = (sql) => sql.split(/;(?=(?:[^']*'[^']*')*[^']*$)/).map(s => s.trim()).filter(Boolean);
	class Database {
		constructor(file, mode, cb) {
			if (typeof mode === 'function') { cb = mode; }
			this.file = file; this.st = openStore(file); this.open = false; this.lastID = 0;
			tick(() => { this.open = true; this.emit?.('open'); cb?.call(this, null); });
		}
		exec(sql, cb) { tick(() => { try { for (const s of splitSql(sql)) { execOne(this.st, s, []); } cb?.call(this, null); } catch (e) { cb ? cb.call(this, e) : this.emit?.('error', e); } }); return this; }
		close(cb) { tick(() => { this.open = false; this.emit?.('close'); cb?.call(this, null); }); return this; }
		serialize(cb) { cb?.(); return this; } parallelize(cb) { cb?.(); return this; } configure() { return this; } wait(cb) { tick(() => cb?.call(this, null)); return this; } interrupt() { } loadExtension(f, cb) { tick(() => cb?.(new Error('loadExtension is not supported'))); return this; }
	}
	class Statement {
		constructor(db, sql, errBack) { this.db = db; this.sql = sql; this.params = []; this.finalized = false; if (errBack) { tick(() => errBack.call(this, null)); } }
		_args(args) { const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined; let params = args.length ? args : this.params; if (params.length === 1 && Array.isArray(params[0])) { params = params[0]; } return { params, cb }; }
		bind(...args) { const { params, cb } = this._args(args); this.params = params; if (cb) { tick(() => cb.call(this, null)); } return this; }
		run(...args) { const { params, cb } = this._args(args); tick(() => { try { const r = execOne(this.db.st, this.sql, params); cb?.call(Object.assign(this, { lastID: 0, changes: r.changes }), null); } catch (e) { cb ? cb.call(this, e) : this.emit?.('error', e); } }); return this; }
		get(...args) { const { params, cb } = this._args(args); tick(() => { try { const r = execOne(this.db.st, this.sql, params); cb?.call(this, null, r.rows[0]); } catch (e) { cb?.call(this, e); } }); return this; }
		all(...args) { const { params, cb } = this._args(args); tick(() => { try { const r = execOne(this.db.st, this.sql, params); cb?.call(this, null, r.rows); } catch (e) { cb?.call(this, e); } }); return this; }
		each(...args) { const done = typeof args[args.length - 1] === 'function' && typeof args[args.length - 2] === 'function' ? args.pop() : undefined; const { params, cb } = this._args(args); tick(() => { try { const r = execOne(this.db.st, this.sql, params); for (const row of r.rows) { cb?.call(this, null, row); } done?.call(this, null, r.rows.length); } catch (e) { cb?.call(this, e); } }); return this; }
		reset(cb) { tick(() => cb?.call(this, null)); return this; }
		finalize(cb) { this.finalized = true; tick(() => cb?.call(this, null)); return this; }
	}
	class Backup { }
	return { Database, Statement, Backup, cached: { objects: {}, Database(f, a, b) { return new Database(f, a, b); } }, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4, OPEN_FULLMUTEX: 0x10000, OPEN_URI: 0x40, OPEN_SHAREDCACHE: 0x20000, OPEN_PRIVATECACHE: 0x40000, VERSION: '3.45.0', SOURCE_ID: 'emulated', VERSION_NUMBER: 3045000, LIMIT_LENGTH: 0, LIMIT_SQL_LENGTH: 1, LIMIT_COLUMN: 2, LIMIT_EXPR_DEPTH: 3, LIMIT_COMPOUND_SELECT: 4, LIMIT_VDBE_OP: 5, LIMIT_FUNCTION_ARG: 6, LIMIT_ATTACHED: 7, LIMIT_LIKE_PATTERN_LENGTH: 8, LIMIT_VARIABLE_NUMBER: 9, LIMIT_TRIGGER_DEPTH: 10, LIMIT_WORKER_THREADS: 11 };
}

// ------------------------------------------------------------------------------------------------------------------------------------ @parcel/watcher (polling)
function makeWatcher() {
	const subs = new Map(); let nextId = 1;
	const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
	const scan = (root, ignoreRes) => {
		const out = new Map(); const stack = [root];
		while (stack.length) {
			const dir = stack.pop(); let names; try { names = fs.readdirSync(dir); } catch { continue; }
			for (const n of names) {
				const p = dir + '/' + n; if (ignoreRes.some(r => r.test(p))) { continue; }
				let s; try { s = fs.lstatSync(p); } catch { continue; }
				out.set(p, s.mtimeMs + ':' + s.size);
				if (s.isDirectory && s.isDirectory()) { stack.push(p); }
			}
		}
		return out;
	};
	return {
		subscribe(dir, fn, opts = {}) {
			const ignoreRes = (opts.ignore || []).map(g => globToRe(path.isAbsolute(g) ? g : path.join(dir, g)));
			const id = nextId++; let prev = scan(dir, ignoreRes);
			const timer = setInterval(() => {
				const cur = scan(dir, ignoreRes); const events = [];
				for (const [p, sig] of cur) { if (!prev.has(p)) { events.push({ type: 'create', path: p }); } else if (prev.get(p) !== sig) { events.push({ type: 'update', path: p }); } }
				for (const p of prev.keys()) { if (!cur.has(p)) { events.push({ type: 'delete', path: p }); } }
				prev = cur; if (events.length) { try { fn(null, events); } catch (e) { /* listener errors are the caller's */ } }
			}, 1000);
			subs.set(id, timer); return Promise.resolve({ unsubscribe() { clearInterval(timer); subs.delete(id); return Promise.resolve(); } });
		},
		unsubscribe(dir, fn, opts) { return Promise.resolve(); },
		writeSnapshot() { return Promise.resolve(); }, getEventsSince() { return Promise.resolve([]); },
	};
}

// ------------------------------------------------------------------------------------------------------------------------------------ registry
function lenientStub(name) { const f = function () { }; return new Proxy(f, { get(t, p) { if (p === 'then' || typeof p === 'symbol') { return undefined; } return lenientStub(name + '.' + String(p)); }, apply() { return lenientStub(name + '()'); }, construct() { return lenientStub('new ' + name); } }); }
const registry = { 'vscode-sqlite3.node': makeSqlite, 'watcher.node': makeWatcher };
const loaded = new Map();
export function installAddons() {
	globalThis.__loadNativeAddon = (filename) => {
		const base = filename.split('/').pop(); if (loaded.has(base)) { return loaded.get(base); }
		const mk = registry[base]; const exp = mk ? mk() : lenientStub(base); loaded.set(base, exp); return exp;
	};
}
