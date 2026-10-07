# Changelog

## 1.0.0

wasmati supports all of WebAssembly 3.0, verified by running the official spec test suite through wasmati in CI, and the standardized proposals beyond it. Modules can be written as WAT, decompiled, and built into `.wasm` files that JS imports without the wasmati runtime.

### Breaking changes

- **`Const` is replaced by `constant()`**, which builds constant expressions with the normal instruction API. Segment offsets also accept numbers, and element segments and table initializers accept functions:

  ```ts
  // before
  global(Const.i32(0), { mutable: true });
  data({ memory, offset: Const.i32(8) }, bytes);
  elem({ type: funcref, mode: { table, offset: Const.i32(0) } }, [Const.refFunc(f), Const.refNull(funcref)]);
  // after
  global(constant(() => i32.const(0)), { mutable: true });
  data({ memory, offset: 8 }, bytes);
  elem({ type: funcref, mode: { table, offset: 0 } }, [f, constant(() => ref.null(funcref))]);
  ```

- **Block instructions take optional options first, then their bodies.** `block`, `loop`, `if_` (`control.if`) and `try_table` no longer take `null` as their type: write `block(() => ...)`, or `block({ in, out }, () => ...)`.
- **`i8x16.relaxed_i8x16_swizzle` is renamed to `i8x16.relaxed_swizzle`.**
- **`memory.atomic.wait32` takes an `i64` timeout**, as in the spec; it took an `i32`.
- **Operands that are instruction results must be the latest values on the stack, in the order they are passed**, as in `i32.sub(a, b)` with `a` computed before `b`, or `call(f, { a: i32.const(1), b: i32.const(2) })` in parameter order. Results are pushed when they are computed, so other orders, or using a result twice, silently produced wrong code; they now throw. Numbers, locals and globals may still come in any order: wasmati inserts them where they belong, and throws if a local or global would be read before a write that comes after earlier operands.
- **Dependency types changed**: memories and tables record their address type, and imports record whether they are async. This only affects code that creates dependency objects without the builder API.
- **The decompiler's output changed** to use the new APIs.

### WebAssembly 3.0

- **Memory64**: `memory({ min, address: "i64" })` and 64-bit tables. Addresses and sizes have the memory's or table's address type, also in TypeScript. Sizes and offsets beyond 2^53 are bigints.
- **Multiple memories**: memory instructions name their memory, `i32.load({ memory }, address)`, and default to the only memory.
- **Typed function references and tail calls**: `refType`, `call_ref`, `return_call`, `return_call_indirect`, `return_call_ref`, `br_on_null`, `br_on_non_null`, and function types with an identity, `funcType`.
- **Extended constant expressions**: `i32.add`, `i32.sub`, `i32.mul` and their i64 variants in `constant()`.
- **Exception handling**: `tag`, `importTag`, `throw_`, `throw_ref`, and `try_table({ catches: [...] }, ...)`.
- **Garbage collection**: struct and array types, `struct({ x: mut(i32) })` and `array(i8)`, packed `i8` and `i16` fields, subtyping, recursion groups with `rec`, and the GC instructions on the `struct`, `array`, `ref`, `i31`, `any` and `extern` namespaces. Fields are accessed by name, and reads and writes have the field's type in TypeScript.
- **Relaxed SIMD**, and **JS string builtins**: `jsString` and `stringConstant`, with JS fallbacks for engines without them.

### Proposals beyond WebAssembly 3.0

- **Branch hinting**: `br_if(label, { likely: true })` and `control.if({ likely: false }, ...)`.
- **JS Promise Integration**: async imports, `importFunc({ ..., async: true }, async () => ...)`, called from async exports, `Module({ exports: { run: async(run) } })`, which return promises. `Module` checks that other exports cannot reach async imports.
- **Compact import sections**, which wasmati decodes and parses.
- Threads and wide arithmetic, which wasmati supported before, are now tested with their proposals' spec tests.

### Text format, decompiler and build

- **WAT**: `Module.fromWat(text)` and `module.toWat()`, and the `wasmati wat` and `wasmati wasm` commands. The printer writes custom sections and names as annotations.
- **The decompiler** accepts WAT as well as Wasm.
- **`wasmati build`** turns a file that default-exports a `Module` into a `.wasm` file that JS imports through the ESM integration of Wasm, with export types, and with inline imports extracted into a JS module. Built modules run in Node and Deno, and in browsers through Vite and Next.js.
- **`Instance<typeof module>`** types instances created without `module.instantiate()`, like those of workers, which instantiate a compiled module with the module's `importMap`.

### Fixes

- `i32.gt_s` and `i64.gt_s` emitted unsigned comparisons.
- Errors about the stack name the instruction or function, like `i32.add: expected i32 on the stack, got i64`.
- Numbers, locals and globals passed after instruction results were inserted in the wrong place after `drop`, `select` and branches on references, could be read before writes that came after earlier operands, and globals among them were missing from the module.
- Functions that code references with `ref.func` are declared, as Wasm requires, by a declarative element segment unless exports or segments declare them. Such modules failed to compile.
- Encoding fixes found by the spec suite, among them element segment flags, local declarations, and the order of globals that read other globals.
- Libraries can export wasmati values with inferred types and emit declarations: every type in wasmati's public signatures is exported, and the value types that are also instruction namespaces have named types, `I32`, `I64`, `F32`, `F64` and `V128`, which declarations use instead of spelling out every instruction.

### Agent skill

[`skills/wasmati/SKILL.md`](skills/wasmati/SKILL.md) documents wasmati for coding agents.

## Earlier versions

Versions before 1.0.0 have no changelog; see the git history.
