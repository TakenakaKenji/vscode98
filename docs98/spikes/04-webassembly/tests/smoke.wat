(module
  (import "env" "log" (func $log (param i32)))
  (memory (export "memory") 1)
  (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add)
  (func (export "callLog") (param i32) local.get 0 call $log)
  (func (export "mul64") (param i64 i64) (result i64) local.get 0 local.get 1 i64.mul)
  (func (export "store") (param i32 i32) local.get 0 local.get 1 i32.store)
  (func (export "boom") unreachable))
