// Node adapter for ts_bench_core.mjs.   node [--jitless] run_node.mjs <repoRoot> <dirRelativeToRoot> [queries]
import * as fs from 'node:fs';
import { runBench } from './ts_bench_core.mjs';
const [root = process.cwd(), dir = 'src/vs/base/common', queries = '15'] = process.argv.slice(2);
const env = {
	engine: 'node ' + process.version + (process.execArgv.includes('--jitless') ? ' --jitless' : ''),
	now: () => performance.now(),
	log: (m) => console.error(m),
	readFile: (p) => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return undefined; } },
	isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
	isDir: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
	listDirs: (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; } },
	listFiles: (d) => fs.readdirSync(d),
	realpath: (p) => { try { return fs.realpathSync(p); } catch { return p; } },
};
const r = runBench(env, { root, dir, tsDir: root + '/extensions/node_modules/typescript/lib', queries: Number(queries), queryFile: 'lifecycle.ts' });
console.log(JSON.stringify(r));
