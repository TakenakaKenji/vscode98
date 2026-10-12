// Spike 2a: engine speed on a real workload = the TypeScript compiler that tsserver runs.
// Portable core: identical JS runs under Node (V8) and QuickJS-ng; only the `env` adapter (file access, clock) differs.
// Phases: load typescript.js (9 MB) -> create program (parse + resolve imports) -> full semantic check -> a few language-service queries.
// Usage: see run_node.mjs / run_qjs.mjs.
export function runBench(env, cfg) {
	const out = { engine: env.engine, phases: {} };
	const t0 = env.now();
	let tPhase = t0;
	const lap = (name) => { const n = env.now(); out.phases[name] = Math.round(n - tPhase); tPhase = n; if (env.log) { env.log('  ' + name + ': ' + out.phases[name] + ' ms'); } };

	// 1. evaluate typescript.js as a CommonJS module with no `require`/`process`, so ts.sys is not created and all I/O goes through our host
	const src = env.readFile(cfg.tsDir + '/typescript.js');
	lap('readTypescriptJs');
	const mod = { exports: {} };
	new Function('module', 'exports', 'require', 'process', '__filename', '__dirname', src)(mod, mod.exports, undefined, undefined, undefined, undefined);
	const ts = mod.exports;
	lap('evaluateTypescriptJs');

	const options = {
		target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, moduleDetection: ts.ModuleDetectionKind.Legacy,
		strict: true, noImplicitReturns: true, noImplicitOverride: true, noUnusedLocals: true, experimentalDecorators: true, useDefineForClassFields: false,
		skipLibCheck: true, noEmit: true, types: [], esModuleInterop: true, allowJs: false,
		lib: ['lib.es2024.d.ts', 'lib.esnext.disposable.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.webworker.importscripts.d.ts'],
	};
	const fileCache = new Map();
	let reads = 0, statCalls = 0;
	const host = {
		getSourceFile(fileName, languageVersionOrOptions) {
			let text = fileCache.get(fileName);
			if (text === undefined) { text = env.readFile(fileName); reads++; fileCache.set(fileName, text === undefined ? null : text); }
			return text ? ts.createSourceFile(fileName, text, languageVersionOrOptions, false) : undefined;
		},
		getDefaultLibFileName: (o) => cfg.tsDir + '/' + ts.getDefaultLibFileName(o),
		writeFile() { },
		getCurrentDirectory: () => cfg.root,
		getCanonicalFileName: (f) => f,
		useCaseSensitiveFileNames: () => true,
		getNewLine: () => '\n',
		fileExists: (f) => { statCalls++; return env.isFile(f); },
		readFile: (f) => { let t = fileCache.get(f); if (t === undefined) { t = env.readFile(f); reads++; fileCache.set(f, t === undefined ? null : t); } return t === null ? undefined : t; },
		directoryExists: (d) => { statCalls++; return env.isDir(d); },
		getDirectories: (d) => env.listDirs(d),
		realpath: (p) => env.realpath(p),
	};
	const rootNames = env.listFiles(cfg.root + '/' + cfg.dir).filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts')).map(f => cfg.root + '/' + cfg.dir + '/' + f).sort();
	lap('listRootFiles');

	const program = ts.createProgram({ rootNames, options, host });
	lap('createProgram_parse_and_resolve');
	out.files = program.getSourceFiles().length;
	out.rootFiles = rootNames.length;

	const syntactic = program.getSyntacticDiagnostics().length;
	lap('syntacticDiagnostics');
	const semanticFiles = program.getSourceFiles().filter(f => !f.isDeclarationFile);
	let semantic = 0;
	for (const f of semanticFiles) { semantic += program.getSemanticDiagnostics(f).length; }
	lap('semanticDiagnostics_typecheck_all');
	const global = program.getGlobalDiagnostics().length + program.getOptionsDiagnostics().length;
	out.result = { syntactic, semantic, global, checkedFiles: semanticFiles.length };

	// 4. interactive-style queries on a language service over the same host (what tsserver does per keystroke)
	const versions = new Map(); rootNames.forEach(f => versions.set(f, '1'));
	const lsHost = Object.assign({}, host, {
		getScriptFileNames: () => rootNames, getScriptVersion: (f) => versions.get(f) || '0', getCompilationSettings: () => options,
		getScriptSnapshot: (f) => { const t = host.readFile(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
	});
	const ls = ts.createLanguageService(lsHost, ts.createDocumentRegistry());
	const target = rootNames.find(f => f.endsWith('/' + cfg.queryFile)) || rootNames[0];
	const text = host.readFile(target);
	const positions = []; const re = /\b(?:this|Disposable|Emitter|URI)\./g; let m;
	while ((m = re.exec(text)) && positions.length < cfg.queries) { positions.push(m.index + m[0].length); }
	lap('languageServiceCreate');
	const first = env.now(); let completions = 0; let firstMs = 0;
	positions.forEach((p, i) => { const r = ls.getCompletionsAtPosition(target, p, {}); completions += r ? r.entries.length : 0; if (i === 0) { firstMs = Math.round(env.now() - first); } });
	lap('completionQueries');
	out.queries = { count: positions.length, firstQueryMs: firstMs, totalCompletionEntries: completions };
	out.fsOps = { reads, statCalls };
	out.totalMs = Math.round(env.now() - t0);
	return out;
}
