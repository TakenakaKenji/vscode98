// ESM shim so the CommonJS node_hook.cjs can be the very first import of out/bootstrap-fork.js (utility processes).
import { createRequire } from 'node:module';
createRequire(import.meta.url)('./node_hook.cjs');
