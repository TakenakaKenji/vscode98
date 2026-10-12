// Smoke test for the WebAssembly API on wasm3. Hand-assembled module:
//   (module (import "env" "log" (func $log (param i32)))
//           (memory (export "memory") 1)
//           (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
//           (func (export "callLog") (param i32) local.get 0 call $log)
//           (func (export "mul64") (param i64 i64) (result i64) local.get 0 local.get 1 i64.mul)
//           (func (export "store") (param i32 i32) local.get 0 local.get 1 i32.store)
//           (func (export "boom") unreachable))
const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x19, 0x05, 0x60, 0x01, 0x7f, 0x00, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f, 0x60, 0x02, 0x7e, 0x7e, 0x01, 0x7e, 0x60, 0x02, 0x7f, 0x7f, 0x00, 0x60, 0x00, 0x00, 0x02, 0x0b, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x03, 0x6c, 0x6f, 0x67, 0x00, 0x00, 0x03, 0x06, 0x05, 0x01, 0x00, 0x02, 0x03, 0x04, 0x05, 0x03, 0x01, 0x00, 0x01, 0x07, 0x31, 0x06, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x03, 0x61, 0x64, 0x64, 0x00, 0x01, 0x07, 0x63, 0x61, 0x6c, 0x6c, 0x4c, 0x6f, 0x67, 0x00, 0x02, 0x05, 0x6d, 0x75, 0x6c, 0x36, 0x34, 0x00, 0x03, 0x05, 0x73, 0x74, 0x6f, 0x72, 0x65, 0x00, 0x04, 0x04, 0x62, 0x6f, 0x6f, 0x6d, 0x00, 0x05, 0x0a, 0x26, 0x05, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b, 0x06, 0x00, 0x20, 0x00, 0x10, 0x00, 0x0b, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x7e, 0x0b, 0x09, 0x00, 0x20, 0x00, 0x20, 0x01, 0x36, 0x02, 0x00, 0x0b, 0x03, 0x00, 0x00, 0x0b]);   // smoke.wasm, assembled from smoke.wat with wat2wasm
async function main() {
	console.log('validate:', WebAssembly.validate(bytes), '| bad bytes:', WebAssembly.validate(new Uint8Array([1, 2, 3])));
	const seen = [];
	const { instance } = await WebAssembly.instantiate(bytes, { env: { log: (x) => seen.push(x) } });
	const e = instance.exports;
	console.log('exports:', Object.keys(e).join(','));
	console.log('add(40,2) =', e.add(40, 2), '| add(2147483647,1) wraps to', e.add(2147483647, 1));
	e.callLog(7); e.callLog(-1); console.log('JS import called with', JSON.stringify(seen));
	console.log('mul64(3n,4n) =', e.mul64(3n, 4n), '| mul64(2^40, 2^20) =', e.mul64(1n << 40n, 1n << 20n));
	e.store(16, 0x12345678);
	const b1 = e.memory.buffer; console.log('memory bytes @16:', Array.from(new Uint8Array(b1, 16, 4)).map(x => x.toString(16)).join(' '), '| size', b1.byteLength, '| same buffer object on repeat:', e.memory.buffer === b1);
	console.log('grow(1) returned', e.memory.grow(1), '| new size', e.memory.buffer.byteLength, '| old buffer detached:', b1.byteLength === 0);
	try { e.boom(); console.log('boom: no error?!'); } catch (err) { console.log('boom ->', err.name + ':', err.message, '| instanceof RuntimeError:', err instanceof WebAssembly.RuntimeError); }
	const { instance: i2 } = await WebAssembly.instantiate(bytes, { env: { log: () => { throw new Error('from JS'); } } });
	try { i2.exports.callLog(1); } catch (err) { console.log('JS exception through wasm ->', err.message); }
	try { await WebAssembly.instantiate(bytes, {}); } catch (err) { console.log('missing import ->', err.name + ':', err.message); }
}
main().catch(e => console.log('FAILED:', e.name, '|', e.message));
