import hello, { flavor } from 'dual';
import { sub } from 'dual/sub';
import cjs, { add } from 'cjsonly';
import fs from 'node:fs';
import { EventEmitter } from 'events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
console.log(hello(), flavor, sub, cjs.name, add(2, 3), typeof fs.readFileSync, typeof EventEmitter);
console.log('import.meta.url', import.meta.url);
const dualViaRequire = require('dual');           // CommonJS require of a dual package picks the "require" condition
console.log('require(dual).flavor =', dualViaRequire.flavor);
const nsViaRequireEsm = require('./esm-only.mjs');   // require(esm), synchronous
console.log('require(esm):', nsViaRequireEsm.value, Object.keys(nsViaRequireEsm).join());
const dyn = await import('dual');
console.log('dynamic import:', dyn.flavor);
try { await import('does-not-exist'); } catch (e) { console.log('missing:', e.code); }
