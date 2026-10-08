import {
  localArray,
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
  constant,
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
  importMemory,
  atomic,
  StackVar,
  decompile,
} from "../src/index.ts";
import assert from "node:assert";
import { writeFile } from "../src/util-node.ts";
import { format, resolveConfig } from "prettier";
import { fileURLToPath } from "node:url";

let log = (...args: any) => console.log("logging from wasm:", ...args);

let consoleLog = importFunc({ name: "consoleLog", in: [{ value: i32 }], out: [] }, log);
let consoleLog64 = importFunc({ name: "consoleLog64", in: [{ value: i64 }], out: [] }, log);
let consoleLogF64 = importFunc({ name: "consoleLogF64", in: [{ value: f64 }], out: [] }, log);
let consoleLogFunc = importFunc({ name: "consoleLogFunc", in: [{ value: funcref }], out: [] }, log);

let mem = importMemory(
  { min: 1, max: 1 << 16, shared: true },
  undefined,
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
);

let myFunc = func(
  { name: "myFunc", in: [{ x: i32 }, { y: i32 }], locals: { tmp: i32, i: i32 }, out: [i32] },
  ({ x, y }, { tmp, i }, ctx) => {
    i64.trunc_sat_f64_s(1.125);
    call(consoleLog64);
    i32.add(x, 0);
    i32.add($, y);
    block({ in: [i32], out: [i32] }, ($block) => {
      local.tee(tmp, $);
      call(consoleLog);
      loop(($loop) => {
        call(consoleLog, { value: i });
        local.tee(i, i32.add(i, 1));
        i32.eq($, 5);
        control.if(() => {
          local.get(tmp);
          control.return();
          // fine that this is missing input, because code path is unreachable
          call(consoleLog);
        });
        br($loop);
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
  },
);

let importedGlobal = importGlobal(i64, 1000n);
let myFuncGlobal = global(
  constant(() => ref.func(myFunc)),
  { type: funcref },
);
let f64Global = global(
  constant(() => f64.const(0)),
  { mutable: true },
);

// this function is not part of the import graph of the module, so won't end up in the assembly
let testUnreachable = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x }) => {
  unreachable();
  // global.get(importedGlobal); // uncommenting shows that we handle type errors after unreachable correctly
  i32.add($, x);
});

let funcTable = table({ type: funcref, min: 4 }, [
  consoleLogFunc,
  myFunc,
  constant(() => ref.null(funcref)),
  constant(() => ref.null(funcref)),
]);

let exportedFunc = func(
  {
    in: [{ x: i32 }, { doLog: i32 }],
    locals: { vectors: localArray(v128, 2), y: i32 },
    out: [i32],
  },
  ({ x, doLog }, { vectors: [_, v], y }) => {
    // call(testUnreachable);
    ref.func(myFunc); // TODO this fails if there is no table but a global, seems to be a V8 bug
    call(consoleLogFunc);
    global.get(myFuncGlobal);
    i32.const(0);
    call_indirect(funcTable, { in: [funcref], out: [] });
    global.set(f64Global, 1.001);
    f64.mul(1.01, f64Global);
    call(consoleLogF64);
    local.get(x);
    local.get(doLog);
    control.if(() => {
      call(consoleLog, { value: x });
    });
    i32.const(2 ** 31 - 1);
    i32.const(-(2 ** 31));
    local.get(doLog);
    select();
    call(consoleLog);
    // drop();
    // local.get(x);
    local.set(y);
    let r1: StackVar<i32> = call(myFunc, { x: y, y: 5 });
    // unreachable();

    i32.const(10);
    memory.grow();
    drop();

    // move int32 at location 4 to location 0
    i32.store({}, i32.const(0), i32.load({ offset: 4 }, 0));

    // test i64
    call(consoleLog64, { value: 64n });

    // test vector instr
    v128.const("i64x2", [1n, 2n]);
    v128.const("i32x4", [3, 4, 5, 6]);
    local.set(v, i32x4.add());
    let $0 = v128.const("f64x2", [0.1, 0.2]);
    let $1 = f64x2.splat(6.25);
    f64x2.mul($0, $1);
    f64x2.extract_lane(1);
    call(consoleLogF64); // should log 1.25

    // test table
    ref.null(funcref);
    i32.const(10);
    table.grow(funcTable);
    drop();

    // test atomic
    i32.atomic.rmw.add({}, 0, 4);
    memory.atomic.notify({}, 0, 0);
    drop();
    drop();
    atomic.fence();
  },
);

const fma = func({ in: [{ x: f64 }, { y: f64 }, { z: f64 }], out: [f64] }, ({ x, y, z }) => {
  f64x2.splat(x);
  f64x2.splat(y);
  f64x2.splat(z);
  f64x2.relaxed_madd();
  f64x2.extract_lane(0);
});

let startFunc = importFunc({ in: [], out: [] }, () => console.log("starting wasm"));

let module = Module({
  name: "example",
  exports: { exportedFunc, fma, importedGlobal, memory: mem },
  start: startFunc,
});

console.dir(module.toObject(), { depth: Infinity });

// create byte code and check roundtrip
let wasmByteCode = module.toBytes();
console.log(`wasm size: ${wasmByteCode.length} byte`);
let recoveredModule = Module.fromBytes(wasmByteCode);
assert.deepStrictEqual(recoveredModule.toObject(), module.toObject());

// write wat file for comparison
await writeFile(import.meta.url.slice(7).replace(".ts", ".wat"), module.toWat());

// Keep the decompiled source alongside the WAT output for comparison.
const decompiledPath = fileURLToPath(new URL("./example.decompiled.ts", import.meta.url));
await writeFile(
  decompiledPath,
  await format(decompile(wasmByteCode, { importPath: "../src/index.ts" }), {
    ...(await resolveConfig(decompiledPath)),
    parser: "typescript",
  }),
);

// instantiate
let wasmModule = await module.instantiate();
let { exports } = wasmModule.instance;
console.log(exports);

// check type inference
exports.exportedFunc satisfies (x: number, doLog: number) => number;
exports.importedGlobal satisfies WebAssembly.Global;
exports.importedGlobal.value satisfies bigint;
exports.memory satisfies WebAssembly.Memory;

// run exported function
let result = exports.exportedFunc(10, 0);
assert(result === 15);
assert(exports.importedGlobal.value === 1000n);
console.log({
  result,
  importedGlobal: exports.importedGlobal.value,
  memory: new Uint8Array(exports.memory.buffer, 0, 8),
});

// Execute the generated source using the same native imports.
const { default: createDecompiledModule } = await import("./example.decompiled.ts");
const rebuilt = await createDecompiledModule(module.importMap).instantiate();
assert.equal(rebuilt.instance.exports.exportedFunc(10, 0), result);
assert.equal(rebuilt.instance.exports.fma(2, 3, 4), exports.fma(2, 3, 4));
assert.equal(rebuilt.instance.exports.memory, exports.memory);
assert.equal(rebuilt.instance.exports.importedGlobal, exports.importedGlobal);
