(module $example
  (type (;0;) (func (param i64)))
  (type (;1;) (func (param i32)))
  (type (;2;) (func (param funcref)))
  (type (;3;) (func (param f64)))
  (type (;4;) (func))
  (type (;5;) (func (param i32 i32) (result i32)))
  (type (;6;) (func (param f64 f64 f64) (result f64)))
  (type (;7;) (func (param i32) (result i32)))
  (import "" "f0" (func $consoleLog64 (type 0)))
  (import "" "f1" (func $consoleLog (type 1)))
  (import "" "f2" (func $consoleLogFunc (type 2)))
  (import "" "f3" (func $consoleLogF64 (type 3)))
  (import "" "f4" (func $f4 (type 4)))
  (import "" "g0" (global $importedGlobal i64))
  (import "" "m0" (memory $memory 1 65536 shared))
  (func $exportedFunc (type 5) (param $x i32) (param $doLog i32) (result i32)
    (local $vectors[0] v128) (local $vectors[1] v128) (local $y i32)
    ref.func $myFunc
    call $consoleLogFunc
    global.get 1
    i32.const 0
    call_indirect (type 2)
    f64.const 0x1.004189374bc6ap+0 (;=1.001;)
    global.set 2
    f64.const 0x1.028f5c28f5c29p+0 (;=1.01;)
    global.get 2
    f64.mul
    call $consoleLogF64
    local.get $x
    local.get $doLog
    if  ;; label = @1
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
    local.set $vectors_1_
    v128.const i32x4 0x9999999a 0x3fb99999 0x9999999a 0x3fc99999
    f64.const 0x1.9p+2 (;=6.25;)
    f64x2.splat
    f64x2.mul
    f64x2.extract_lane 1
    call $consoleLogF64
    ref.null func
    i32.const 10
    table.grow 0
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
  (func $myFunc (type 5) (param $x i32) (param $y i32) (result i32)
    (local $tmp i32) (local $i i32)
    f64.const 0x1.2p+0 (;=1.125;)
    i64.trunc_sat_f64_s
    call $consoleLog64
    local.get $y
    local.get $x
    i32.const 0
    i32.add
    i32.add
    block (param i32) (result i32)  ;; label = @1
      local.tee $tmp
      call $consoleLog
      loop  ;; label = @2
        local.get $i
        call $consoleLog
        local.get $i
        i32.const 1
        i32.add
        local.tee $i
        i32.const 5
        i32.eq
        if  ;; label = @3
          local.get $tmp
          return
          call $consoleLog
        end
        br 0 (;@2;)
        local.get $i
        i32.ne
        br_if 0 (;@2;)
      end
      local.get $tmp
      local.get $tmp
      drop
    end)
  (func $fma (type 6) (param $x f64) (param $y f64) (param $z f64) (result f64)
    local.get $x
    f64x2.splat
    local.get $y
    f64x2.splat
    local.get $z
    f64x2.splat
    f64x2.relaxed_madd
    f64x2.extract_lane 0)
  (table (;0;) 4 funcref)
  (global (;1;) funcref (ref.func $myFunc))
  (global (;2;) (mut f64) (f64.const 0x0p+0 (;=0;)))
  (export "exportedFunc" (func $exportedFunc))
  (export "fma" (func $fma))
  (export "importedGlobal" (global $importedGlobal))
  (export "memory" (memory $memory))
  (start $f4)
  (elem (;0;) (i32.const 0) funcref (ref.func $consoleLogFunc) (ref.func $myFunc) (ref.null func) (ref.null func))
  (data (;0;) (i32.const 0) "\00\01\02\03\04\05\06\07\08\09\0a\0b"))
