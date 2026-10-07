---
name: wasmati
description: Write WebAssembly modules in TypeScript with wasmati, a library whose API mirrors Wasm instructions. Covers functions, locals, instructions and their operands, control flow, types including GC structs and arrays, memories, tables, globals, constant expressions, imports and exports, async imports and exports (JSPI), JS string builtins, the text format, decompiling, and `wasmati build`. Use when writing, reading or debugging code that imports wasmati.
---

# wasmati

wasmati builds Wasm modules from TypeScript. Builder calls like `i32.add()` emit one instruction each into the function being built, and wasmati checks the operand stack as you go: a type error throws at the call that caused it. `Module({ exports })` collects everything the exports need and produces the module.

Every example below that starts with an import runs in wasmati's test suite.

## A module

```ts
import { Module, func, i32, local } from "wasmati";

const add = func({ in: [{ x: i32 }, { y: i32 }], out: [i32] }, ({ x, y }) => {
  local.get(x);
  local.get(y);
  i32.add();
});

const module = Module({ exports: { add } });
const { instance } = await module.instantiate();
instance.exports.add(1, 2); // 3, typed as (x: number, y: number) => number
```

- `func({ in, out, locals }, body)`: parameters are named and ordered, `in: [{ x: i32 }, { y: i64 }]`. The body gets parameters and locals as `Local` objects, and must leave exactly the results on the stack.
- JS sees `i32`, `f32` and `f64` as numbers, `i64` as bigints, and references as JS values.
- `module.toBytes()` gives the binary, `module.toWat()` the text format. `Module.fromBytes(bytes)` and `Module.fromWat(text)` read modules back.

## Instructions and operands

Instructions take their operands from the stack. They also accept them as arguments: numbers become constants, locals and globals are read, and instruction results are used where they are. Each instruction returns its result, which can be an operand of the next one. `$` stands for the value on top of the stack.

```ts
import { Module, func, i32, i64, local, $ } from "wasmati";

const f = func(
  { in: [{ x: i32 }], locals: { y: i64 }, out: [i32] },
  ({ x }, { y }) => {
    local.set(y, i64.extend_i32_u(x));
    const doubled = i32.mul(x, 2); // local.get x, i32.const 2, i32.mul
    i32.add(doubled, i32.wrap_i64(y));
    i32.shl($, 1); // shifts the value on the stack
  },
);

const { instance } = await Module({ exports: { f } }).instantiate();
instance.exports.f(5); // ((5 * 2) + 5) << 1 = 30
```

- Namespaces follow Wasm: `i32`, `i64`, `f32`, `f64`, `v128` and the lane shapes `i8x16` to `f64x2`, `local`, `global`, `ref`, `memory`, `data`, `table`, `elem`, `struct`, `array`, `i31`, `any`, `extern`, `atomic`. Control instructions are exported directly: `block`, `loop`, `if_` (also `control.if`), `br`, `br_if`, `br_table`, `return_`, `call`, `call_indirect`, `call_ref`, `throw_`, `try_table`, `drop`, `select`, `nop`, `unreachable`, and so on.
- Constants: `i32.const(1)`, `i64.const(1n)`, `f64.const(1.5)`. `i64` values are always bigints.
- Operand types are checked in TypeScript and when building: `i32.add(x, u)` with an `i64` local `u` is a type error.

## Functions and calls

```ts
import { Module, func, declareFunc, importFunc, i32, call, control } from "wasmati";

const log = importFunc({ in: [{ value: i32 }], out: [] }, (value) => console.log(value));

// Declare first to allow recursion, or calls before the definition.
const factorial = declareFunc({ name: "factorial", in: [{ n: i32 }], out: [i32] });
factorial.define(({ n }) => {
  call(log, { value: n });
  i32.le_s(n, 1);
  control.if(
    { out: [i32] },
    () => i32.const(1),
    () => i32.mul(n, call(factorial, { n: i32.sub(n, 1) })),
  );
});

const run = func({ in: [], out: [i32] }, () => call(factorial, { n: 5 }));
const { instance } = await Module({ exports: { run } }).instantiate();
instance.exports.run(); // 120
```

- `call(f, { name: value })` passes operands by parameter name. Operands that are instruction results must be written in parameter order, because they are on the stack in the order they are evaluated; wasmati throws otherwise. Numbers, locals and globals may come in any order.
- `call(f)` without operands takes them from the stack.
- Parameter, local and export names go into the name section, so names show up in stack traces and decompiled code.

## Control flow

Block instructions take optional options, then their bodies. Bodies get their label, which `br`, `br_if` and `br_table` take, as do relative depths.

```ts
import { Module, func, i32, local, block, loop, br, br_if, control } from "wasmati";

const sumTo = func({ in: [{ n: i32 }], locals: { sum: i32 }, out: [i32] }, ({ n }, { sum }) => {
  block((done) => {
    loop((next) => {
      i32.eqz(n);
      br_if(done);
      local.set(sum, i32.add(sum, n));
      local.set(n, i32.sub(n, 1));
      br(next);
    });
  });
  local.get(sum);
});

const sign = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  i32.lt_s(x, 0);
  control.if(
    { out: [i32] },
    () => i32.const(-1),
    () => i32.const(1),
  );
});

const { instance } = await Module({ exports: { sumTo, sign } }).instantiate();
instance.exports.sumTo(4); // 10
```

- Options: `{ in, out }` types the block's parameters and results; `if_` and `br_if` take `likely: boolean` as a branch hint; `try_table` takes `catches`.
- `if_` takes its condition from the stack, and an optional else body.
- `return_()` returns from the function.

## Types

Value types: `i32`, `i64`, `f32`, `f64`, `v128`, and reference types. `funcref`, `externref`, `anyref`, `eqref`, `i31ref`, `structref`, `arrayref`, `exnref` and the null types are nullable references to abstract heap types. `refType(heap, { nullable })` makes others: `refType("any")` is a non-null `anyref`.

Defined types:

```ts
import { Module, func, struct, array, funcType, rec, mut, i8, i32, f64, refType, local } from "wasmati";

const point = struct({ x: i32, y: mut(i32) });
const bytes = array(mut(i8)); // packed: read and written as i32
const binary = funcType({ in: [i32, i32], out: [i32] });

// Recursive types refer to each other through the callback's argument.
const { node } = rec((types) => ({
  node: struct({ value: f64, next: refType(types.node, { nullable: true }) }),
}));

// Subtypes: types are final unless `final: false`.
const shape = struct({ area: f64 }, { final: false });
const circle = struct({ area: f64, radius: f64 }, { supertype: shape });

const id = func({ in: [{ p: refType(point) }], out: [refType(point)] }, ({ p }) => local.get(p));
Module({ exports: { id } });
```

- Struct field names are their keys, in order. `mut(t)` makes a field mutable; `i8` and `i16` are packed storage types.
- Equivalent types are the same Wasm type, as in Wasm's isorecursive type system.

## Garbage collection

```ts
import { Module, func, struct, array, mut, i32, i8, f64, refType, ref, local } from "wasmati";

const point = struct({ x: mut(i32), y: i32 });
const values = array(mut(f64));

const f = func({ in: [], locals: { p: refType(point) }, out: [i32] }, (_, { p }) => {
  local.set(p, struct.new(point, { x: 1, y: 2 }));
  struct.set(point, "x", p, 10);
  i32.add(struct.get(point, "x", p), struct.get(point, "y", p));
});

const g = func({ in: [], out: [f64] }, () => {
  const a = array.new_fixed(values, [1.5, 2.5]);
  array.get(values, a, 1);
});

const isPoint = func({ in: [{ v: refType("any", { nullable: true }) }], out: [i32] }, ({ v }) =>
  ref.test(refType(point), v),
);

const { instance } = await Module({ exports: { f, g, isPoint } }).instantiate();
instance.exports.f(); // 12
```

- Fields are accessed by name, and reads and writes have the field's type in TypeScript. Packed fields need `get_s` or `get_u`.
- Arrays: `array.new(type, value, length)`, `new_default`, `new_fixed(type, length | elements)`, `new_data`, `new_elem`, `get`, `set`, `len`, `fill`, `copy`, `init_data`, `init_elem`.
- References: `ref.null(type)`, `ref.is_null`, `ref.as_non_null`, `ref.eq`, `ref.test(type)`, `ref.cast(type)`, `ref.i31` with `i31.get_s`/`get_u`, `br_on_cast(label, from, to)`, `br_on_cast_fail`, `any.convert_extern`, `extern.convert_any`.

## Memory, tables and globals

```ts
import { Module, func, memory, data, table, elem, global, constant, funcref, i32, i64 } from "wasmati";

const mem = memory({ min: 1, max: 2 });
data({ memory: mem, offset: 0 }, [1, 2, 3, 4]); // an active data segment

const read = func({ in: [{ address: i32 }], out: [i32] }, ({ address }) =>
  i32.load({ memory: mem, offset: 0, align: 4 }, address),
);

const counter = global(constant(() => i32.const(0)), { mutable: true });
const increment = func({ in: [], out: [i32] }, () => {
  global.set(counter, i32.add(global.get(counter), 1));
  global.get(counter);
});

const functions = table({ type: funcref, min: 1 });
elem({ type: funcref, mode: { table: functions, offset: 0 } }, [increment]);

const big = memory({ min: 1, address: "i64" }); // memory64: addresses are i64
const size = func({ in: [], out: [i64] }, () => memory.size(big));

const { instance } = await Module({ exports: { read, increment, mem, size } }).instantiate();
instance.exports.read(0); // 0x04030201
```

- Memory instructions take a memory argument `{ memory, offset, align }`, with `align` in bytes. Without `memory`, they use the module's only memory, which must be 32-bit. Modules with several memories name them in every instruction.
- Addresses and sizes have the memory's or table's address type: `i64` for `address: "i64"`.
- Data and element segments are active with `{ memory | table, offset }`, or `"passive"`; element segments can be `"declarative"`. Offsets are numbers or constant expressions.
- `constant(() => ...)` builds constant expressions with the normal instruction API: constants, `global.get`, `ref.null`, `ref.func`, `i32`/`i64` `add`, `sub` and `mul`, and GC allocations. It is used for global initializers, offsets, element items and table initializers.
- `Module({ exports, memory: { min } })` adds a memory without exporting it by name.

## Imports and exports

```ts
import { Module, func, importFunc, importGlobal, importMemory, i32, call, global } from "wasmati";

const log = importFunc({ in: [{ x: i32 }], out: [] }, (x) => console.log(x));
const base = importGlobal(i32, 100);
const shared = importMemory({ min: 1 }, new WebAssembly.Memory({ initial: 1 }));
const f = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  call(log, { x });
  i32.add(x, global.get(base));
});

const module = Module({ exports: { f, shared } });
const { instance } = await module.instantiate(); // the import object is built for you
```

- Imports declare their type together with their JS value; `module.importMap` holds the import object. `module` and `field` set an explicit import path.
- Exports are the keys of `exports`: functions, globals, memories, tables and tags.
- Only what the exports and the start function need ends up in the module. `dependencies` adds more.

## Async imports and exports (JSPI)

Wasm can wait for async JS: an async import returns a promise, and Wasm suspends until it resolves. JS must enter such Wasm through an async export, which returns a promise.

```ts
import { Module, func, importFunc, i32, call, async } from "wasmati";

const fetchValue = importFunc({ in: [{ id: i32 }], out: [i32], async: true }, async (id) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return id * 2;
});
const run = func({ in: [{ id: i32 }], out: [i32] }, ({ id }) => {
  i32.add(call(fetchValue, { id }), 1);
});

const { instance } = await Module({ exports: { run: async(run) } }).instantiate();
await instance.exports.run(20); // 41
```

- Functions in between stay ordinary functions: the engine suspends the whole Wasm stack.
- `Module` throws if an export that is not async, or the start function, can reach an async import through direct calls. Indirect calls fail at runtime with `WebAssembly.SuspendError`.

## JS strings

```ts
import { Module, func, call, jsString, stringConstant, externref, global, i32 } from "wasmati";

const hello = stringConstant("hello ");
const greet = func({ in: [{ name: externref }], out: [externref] }, ({ name }) =>
  call(jsString.concat, { first: global.get(hello), second: name }),
);
const length = func({ in: [{ s: externref }], out: [i32] }, ({ s }) =>
  call(jsString.length, { string: s }),
);

const { instance } = await Module({ exports: { greet, length } }).instantiate();
instance.exports.greet("wasmati"); // "hello wasmati"
```

`jsString` has the JS string builtins as imports, and `jsString.charCodeArray` is the `(array (mut i16))` type of the array builtins. Engines provide the builtins; elsewhere, their JS functions behave the same.

## Exceptions

```ts
import { Module, func, tag, throw_, try_table, block, i32, drop } from "wasmati";

const failure = tag({ in: [i32] });
const f = func({ in: [], out: [i32] }, () => {
  block({ out: [i32] }, (caught) => {
    try_table({ catches: [{ tag: failure, label: caught }] }, () => {
      i32.const(42);
      throw_(failure);
    });
    i32.const(0);
  });
});

const { instance } = await Module({ exports: { f } }).instantiate();
instance.exports.f(); // 42
```

Catch clauses branch to enclosing labels with the exception's values; `catch_all` clauses omit `tag`, and `ref: true` adds an `exnref` for `throw_ref`.

## Text format and decompiling

- `Module.fromWat(text)` and `module.toWat()` read and print the WebAssembly text format.
- `decompile(bytesOrWat)` returns wasmati TypeScript whose default export builds the module from an import object.
- CLI: `wasmati decompile input.wasm -o output.ts`, `wasmati wat input.wasm`, `wasmati wasm input.wat -o output.wasm`. Inputs may be Wasm or WAT.

## Building modules without wasmati

`wasmati build file.ts -o dir` turns a file that default-exports a `Module` into `file.wasm`, which JS imports directly through the ESM integration of Wasm, `import { f } from "./dir/file.wasm"`, without the wasmati runtime.

- The build writes export types to `file.d.wasm.ts` (TypeScript reads them with `allowArbitraryExtensions`).
- Imports written inline are extracted into `file.host.js` with the top-level declarations and imports they use. The built file may only export its `Module`; share state with the app through another module.
- The build rejects what it cannot copy faithfully: functions that use variables or `this` of an enclosing function, wasmati values, declarations that code running during the build also uses, and memories written during the build.
- Async exports get an entry module, `file.js`, which JS imports instead.
- Built modules run in Node 22.19 or 24.5 and later, and Deno 2.1 and later. Browsers need a bundler: Vite with `vite-plugin-wasm`, or Next.js with Turbopack. Modules that use JS string builtins also need the bundler to map `wasm:js-string` to the generated `js-string.js`.

## Pitfalls

- A function body must leave exactly its results on the stack; leftover values throw `expected stack to be empty`.
- Instruction results given as named operands, to `call` or `struct.new`, must come in parameter order.
- `i64` values are bigints: `i64.const(1n)`, and `i64` operands take bigints, not numbers.
- With a 64-bit memory or several memories, memory instructions must name their memory.
- Exported async functions must be wrapped, `async(run)`, if they reach async imports.
- After `br`, `return_`, `throw_` or `unreachable`, the rest of the block is unreachable code, where any stack types are accepted.
