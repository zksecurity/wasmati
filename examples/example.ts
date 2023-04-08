import {
  Module,
  func,
  control,
  i32,
  i64,
  local,
  global,
  ref,
  drop,
  select,
  funcref,
  importFunc,
  importGlobal,
  memory,
  Const,
  f64,
  call,
  block,
  loop,
  br,
  br_if,
  unreachable,
  call_indirect,
  v128,
  i32x4,
  f64x2,
  table,
  $,
} from "../src/index.js";
import assert from "node:assert";
import fs from "node:fs";
import Wabt from "wabt";
import { writeFile } from "../src/util-node.js";

const wabt = await Wabt();

let log = (...args: any) => console.log("logging from wasm:", ...args);

let consoleLog = importFunc({ in: [i32], out: [] }, log);
let consoleLog64 = importFunc({ in: [i64], out: [] }, log);
let consoleLogF64 = importFunc({ in: [f64], out: [] }, log);
let consoleLogFunc = importFunc({ in: [funcref], out: [] }, log);

let mem = memory(
  { min: 1, max: 2 ** 16 },
  Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
);

let myFunc = func(
  { in: [i32, i32], locals: [i32, i32], out: [i32] },
  ([x, y], [tmp, i], ctx) => {
    i64.trunc_sat_f64_s(f64.const(1.125));
    call(consoleLog64);
    i32.add(local.get(x), i32.const(0));
    local.get(y);
    i32.add();
    block({ in: [i32], out: [i32] }, (block) => {
      local.tee(tmp);
      call(consoleLog);
      loop({}, (loop) => {
        local.get(i);
        call(consoleLog);
        local.get(i);
        i32.const(1);
        i32.add();
        local.tee(i);
        i32.const(5);
        i32.eq();
        control.if({}, () => {
          local.get(tmp);
          control.return();
          // fine that this is missing input, because code path is unreachable
          call(consoleLog);
        });
        br(loop);
        // unreachable
        local.get(i);
        // i64.const(10n);
        i32.ne();
        br_if(0);
      });
      local.get(tmp);
      local.get(tmp);
      drop();
    });
  }
);

let importedGlobal = importGlobal(i64, 1000n);
let myFuncGlobal = global(Const.refFunc(myFunc));

let testUnreachable = func({ in: [], locals: [], out: [] }, () => {
  unreachable();
  // global.get(importedGlobal);
  i32.add();
  call(consoleLog);
});

let funcTable = table({ type: funcref, min: 4 }, [
  Const.refFunc(consoleLogFunc),
  Const.refFunc(myFunc),
  Const.refFuncNull,
  Const.refFuncNull,
]);

let exportedFunc = func(
  {
    in: [i32, i32],
    locals: [v128, i32, v128],
    out: [i32],
  },
  ([x, doLog], [_, y, v]) => {
    // call(testUnreachable);
    ref.func(myFunc); // TODO this fails if there is no table but a global, seems to be a V8 bug
    call(consoleLogFunc);
    global.get(myFuncGlobal);
    i32.const(0);
    call_indirect(funcTable, { in: [funcref], out: [] });
    local.get(x);
    local.get(doLog);
    control.if(null, () => {
      local.get(x);
      call(consoleLog);
      // console.log({ stack: ctx.stack });
    });
    i32.const(2 ** 31 - 1);
    i32.const(-(2 ** 31));
    local.get(doLog);
    select();
    call(consoleLog);
    // drop();
    // local.get(x);
    local.set(y);
    local.get(y);
    i32.const(5);
    call(myFunc);
    // unreachable();

    i32.const(10);
    memory.grow();
    drop();

    // move int32 at location 4 to location 0
    i32.const(0);
    i32.const(0);
    i32.load({ offset: 4 });
    i32.store({});

    // test vector instr
    v128.const("i64x2", [1n, 2n]);
    v128.const("i32x4", [3, 4, 5, 6]);
    i32x4.add();
    local.set(v);
    let $0 = v128.const("f64x2", [0.1, 0.2]);
    let $1 = f64x2.splat(f64.const(6.25));
    f64x2.mul($0, $1);
    f64x2.extract_lane(1);
    call(consoleLogF64); // should log 1.25

    // test table
    ref.null(funcref);
    i32.const(10);
    table.grow(funcTable);
    drop();
  }
);

let startFunc = importFunc({ in: [], out: [] }, () =>
  console.log("starting wasm")
);

let module = Module({
  exports: { exportedFunc, importedGlobal, memory: mem },
  start: startFunc,
});

console.dir(module.module, { depth: Infinity });

// create byte code and check roundtrip
let wasmByteCode = module.toBytes();
console.log(`wasm size: ${wasmByteCode.length} byte`);
let recoveredModule = Module.fromBytes(wasmByteCode);
assert.deepStrictEqual(recoveredModule, module.module);

// write wat file for comparison
let wabtModule = wabt.readWasm(wasmByteCode, wabtFeatures());
let wat = wabtModule.toText({});
await writeFile(import.meta.url.slice(7).replace(".ts", ".wat"), wat);

// instantiate & run exported function
let wasmModule = await module.instantiate();
let { exports } = wasmModule.instance;
console.log(exports);
let result = exports.exportedFunc(10, 0);
assert(result === 15);
assert(exports.importedGlobal.value === 1000n);
console.log({
  result,
  importedGlobal: exports.importedGlobal.value,
  memory: new Uint8Array(exports.memory.buffer, 0, 8),
});

// wabt features

function wabtFeatures() {
  return {
    /** Experimental exception handling. */
    exceptions: true,
    /** Import/export mutable globals. */
    mutable_globals: true,
    /** Saturating float-to-int operators. */
    sat_float_to_int: true,
    /** Sign-extension operators. */
    sign_extension: true,
    /** SIMD support. */
    simd: true,
    /** Threading support. */
    threads: true,
    /** Multi-value. */
    multi_value: true,
    /** Tail-call support. */
    tail_call: true,
    /** Bulk-memory operations. */
    bulk_memory: true,
    /** Reference types (externref). */
    reference_types: true,
  };
}
