import { Module, func, i32, i64, type ModuleInstance } from "../index.ts";

// Compile-only assertions: ModuleInstance names the typed instance of a module.
async function checkInstance() {
  const add = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => i32.add(x, y));
  const wide = func({ in: [{ x: i64 }], out: [i64] }, ({ x }) => i64.add(x, 1n));
  const wasm = Module({ exports: { add, wide } });
  const { instance, module } = await wasm.instantiate();
  instance satisfies ModuleInstance<typeof wasm>;
  const other = await WebAssembly.instantiate(module, wasm.importMap);
  const exports = (other as ModuleInstance<typeof wasm>).exports;
  exports.add(1, 2) satisfies number;
  exports.wide(1n) satisfies bigint;
  // @ts-expect-error i64 takes bigints
  exports.wide(1);
}
checkInstance;
