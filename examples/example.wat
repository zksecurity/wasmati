(module $example
  (type (func (param i32) (result i32)))
  (type (func (param funcref)))
  (type (func (param i64)))
  (type (func (param i32)))
  (type (func (param f64)))
  (type (func))
  (type (func (param i32 i32) (result i32)))
  (type (func (param f64 f64 f64) (result f64)))
  (import "" "f0" (func $consoleLog64 (param $value i64)))
  (import "" "f1" (func $consoleLog (param $value i32)))
  (import "" "f2" (func $consoleLogFunc (param $value funcref)))
  (import "" "f3" (func $consoleLogF64 (param $value f64)))
  (import "" "f4" (func $f4))
  (import "" "g0" (global $importedGlobal i64))
  (import "" "m0" (memory $memory 1 65536 shared))
  (func $exportedFunc (param $x i32) (param $doLog i32) (result i32)
    (local $"vectors[0]" v128)
    (local $"vectors[1]" v128)
    (local $y i32)
    ref.func $myFunc
    call $consoleLogFunc
    global.get 1
    i32.const 0
    call_indirect (param funcref)
    f64.const 1.001
    global.set 2
    f64.const 1.01
    global.get 2
    f64.mul
    call $consoleLogF64
    local.get $x
    local.get $doLog
    if
      local.get $x
      call $consoleLog
    end
    i32.const 2147483647
    i32.const -2147483648
    local.get $doLog
    select
    call $consoleLog
    local.set $y
    local.get $y
    i32.const 5
    call $myFunc
    i32.const 10
    memory.grow
    drop
    i32.const 0
    i32.const 0
    i32.load offset=4
    i32.store
    i64.const 64
    call $consoleLog64
    v128.const i32x4 0x00000001 0x00000000 0x00000002 0x00000000
    v128.const i32x4 0x00000003 0x00000004 0x00000005 0x00000006
    i32x4.add
    local.set $"vectors[1]"
    v128.const i32x4 0x9999999a 0x3fb99999 0x9999999a 0x3fc99999
    f64.const 6.25
    f64x2.splat
    f64x2.mul
    f64x2.extract_lane 1
    call $consoleLogF64
    ref.null func
    i32.const 10
    table.grow
    drop
    i32.const 0
    i32.const 4
    i32.atomic.rmw.add
    i32.const 0
    i32.const 0
    memory.atomic.notify
    drop
    drop
    atomic.fence)
  (func $myFunc (param $x i32) (param $y i32) (result i32)
    (local $tmp i32)
    (local $i i32)
    f64.const 1.125
    i64.trunc_sat_f64_s
    call $consoleLog64
    local.get $y
    local.get $x
    i32.const 0
    i32.add
    i32.add
    block (param i32) (result i32)
      local.tee $tmp
      call $consoleLog
      loop
        local.get $i
        call $consoleLog
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        i32.const 5
        i32.eq
        if
          local.get $tmp
          return
          call $consoleLog
        end
        br 0
        local.get $i
        i32.ne
        br_if 0
      end
      local.get $tmp
      local.get $tmp
      drop
    end)
  (func $fma (param $x f64) (param $y f64) (param $z f64) (result f64)
    local.get $x
    f64x2.splat
    local.get $y
    f64x2.splat
    local.get $z
    f64x2.splat
    f64x2.relaxed_madd
    f64x2.extract_lane 0)
  (table 4 funcref)
  (global funcref ref.func $myFunc)
  (global (mut f64) f64.const 0)
  (export "exportedFunc" (func $exportedFunc))
  (export "fma" (func $fma))
  (export "importedGlobal" (global $importedGlobal))
  (export "memory" (memory $memory))
  (start $f4)
  (elem (offset i32.const 0) funcref (item ref.func $consoleLogFunc) (item ref.func $myFunc) (item ref.null func) (item ref.null func))
  (data (offset i32.const 0) "\00\01\02\03\04\05\06\07\08\09\0a\0b"))
