---
name: wasmati
description: Writing, reading or debugging WebAssembly with wasmati, a TypeScript library.
---

# wasmati

WebAssembly (Wasm) is a compact, low-level language that JS engines compile to machine code. wasmati lets you write Wasm from TypeScript: each builder call, like `i32.add()`, appends one Wasm instruction to the function being built, and `Module(...)` turns your definitions into a Wasm module that JS can instantiate. Since the API mirrors Wasm, learning wasmati means learning Wasm, and this guide teaches both.

wasmati suits hand-written, performance-critical code and code generators. It is not a compiler: the module contains exactly the instructions you write, in the order you write them, and TypeScript only makes writing them comfortable. Where this guide stays brief, the [WebAssembly specification](https://webassembly.github.io/spec/core/) and the [MDN WebAssembly reference](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference) have the details; the spec's [index of instructions](https://webassembly.github.io/spec/core/appendix/index-instructions.html) lists every instruction with its type.

Every example below that starts with an import runs in wasmati's test suite.

## A first module

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

A **module** is a set of definitions, like functions, memories, tables and globals, together with the **imports** it needs from its host and the **exports** it offers. `func` defines a function: its parameters (`in`), results (`out`) and body. `Module({ exports })` collects everything the exports need, and `instantiate()` compiles the module and instantiates it in the JS engine. To see what wasmati produced, print `module.toWat()`, the module in the [WebAssembly text format](https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Understanding_the_text_format).

## Values and types

Wasm has few value types:

- `i32` and `i64`: 32- and 64-bit integers. They have no sign: instructions decide how to interpret them, like `i32.div_s` (signed) and `i32.div_u` (unsigned).
- `f32` and `f64`: IEEE floating-point numbers.
- `v128`: 128 bits for SIMD instructions, which operate on several lanes at once, like four `i32`s.
- References: handles to functions, to JS values, or to garbage-collected objects. Wasm code cannot see their address.

At the boundary with JS, values convert as follows:

| Wasm               | JS                                                                 |
| ------------------ | ------------------------------------------------------------------ |
| `i32`              | number, as a signed 32-bit integer; `x >>> 0` reads it as unsigned |
| `i64`              | bigint, signed                                                     |
| `f32`, `f64`       | number                                                             |
| `v128`             | not allowed at the boundary                                        |
| `funcref`          | a Wasm function                                                    |
| `externref`        | any JS value                                                       |
| `i31ref`           | number                                                             |
| structs and arrays | opaque objects, which JS can pass back but not read                |
| null references    | `null`                                                             |

Functions with several results return them to JS as an array.

## The stack machine

Wasm instructions operate on an implicit **operand stack**: each instruction pops its operands and pushes its results. `i32.const(2)` pushes 2; `i32.add()` pops two `i32` values and pushes their sum. A function's body must leave exactly its results on the stack.

Wasm is **validated** before it runs: the engine checks that every instruction finds operands of the right types. wasmati checks the same while you build, so a mistake throws at the call that caused it, with a stack trace into your code, like `i32.add: expected i32 on the stack, got i64`.

wasmati also lets you pass operands as arguments. Numbers become constants, locals and globals are read, and each instruction returns its result, which can be the operand of another one. `$` stands for the value already on the stack.

```ts
import { Module, func, i32, i64, local, $ } from "wasmati";

const f = func({ in: [{ x: i32 }], locals: { y: i64 }, out: [i32] }, ({ x }, { y }) => {
  local.set(y, i64.extend_i32_u(x));
  const doubled = i32.mul(x, 2); // local.get x; i32.const 2; i32.mul
  i32.add(doubled, i32.wrap_i64(y));
  i32.shl($, 1); // shifts the value on the stack
});

const { instance } = await Module({ exports: { f } }).instantiate();
instance.exports.f(5); // ((5 * 2) + 5) << 1 = 30
```

Both styles produce the same instructions, in the order the calls run. An instruction's result is pushed when its call runs, so operands that are instruction results must be the latest values on the stack, in the order the operands are passed: compute them in that order, and use each once. wasmati throws otherwise. Numbers, locals and globals can come in any position: wasmati inserts their instructions where they belong, as in `i32.sub(5, x)` with `x` computed first. Some instructions take named operands, like `call(f, { x, y })` and `struct.new(type, { a, b })`, where the order is the declared order of the parameters or fields. The stack style matches the text format and the spec; the expression style reads like code. Mix them freely. TypeScript checks operand types too: an `i64` local where `i32.add` expects an `i32` is a type error.

## Control flow

Wasm has no `goto`: control flow is structured into nested **blocks**. A branch instruction names an enclosing block by its **label**. Branching to a `block` jumps to its end; branching to a `loop` jumps back to its start. `if_` runs one of two bodies, depending on an `i32` that counts as true when nonzero. Blocks are typed like functions: by the values they take from the stack and the values they leave on it.

In wasmati, block instructions take optional options, `{ in, out }` for their types, and then their bodies, which receive their label. Instructions named like JS keywords end with `_`: `if_`, `return_`, `throw_`. They are also available without it on the `control` namespace, like `control.if`.

```ts
import { Module, func, i32, local, block, loop, br, br_if, if_ } from "wasmati";

const sumTo = func({ in: [{ n: i32 }], locals: { sum: i32 }, out: [i32] }, ({ n }, { sum }) => {
  block((done) => {
    loop((next) => {
      i32.eqz(n);
      br_if(done); // leave the loop when n is 0
      local.set(sum, i32.add(sum, n));
      local.set(n, i32.sub(n, 1));
      br(next); // run the loop again
    });
  });
  local.get(sum);
});

const sign = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  i32.lt_s(x, 0);
  if_(
    { out: [i32] },
    () => i32.const(-1),
    () => i32.const(1),
  );
});

const { instance } = await Module({ exports: { sumTo, sign } }).instantiate();
instance.exports.sumTo(4); // 10
instance.exports.sign(-5); // -1
```

- `br(label)` branches; `br_if(label)` branches if the `i32` on the stack is nonzero; `br_table(labels, default)` branches to one of several labels by index, like a `switch`. Branches carry the values their target expects: a block's results, or a loop's parameters.
- After an unconditional branch, `return_()` or `unreachable()`, the rest of the block never runs. Such code is still validated, but accepts any stack.
- `select()` picks one of two values by a condition, without branching.
- `if_` and `br_if` accept a branch hint, `{ likely: true }`, which helps engines lay out the code.
- Some faults **trap**: integer division by zero, out-of-bounds memory access, `unreachable()`. A trap aborts the Wasm code and throws a `WebAssembly.RuntimeError` in JS.

[MDN's control flow reference](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/Control_flow) describes each instruction.

## Functions, locals and calls

```ts
import { Module, func, declareFunc, i32, call, if_ } from "wasmati";

// Declaring first allows recursion, and calls before the definition.
const factorial = declareFunc({ name: "factorial", in: [{ n: i32 }], out: [i32] });
factorial.define(({ n }) => {
  i32.le_s(n, 1);
  if_(
    { out: [i32] },
    () => i32.const(1),
    () => i32.mul(n, call(factorial, { n: i32.sub(n, 1) })),
  );
});

const run = func({ in: [], out: [i32] }, () => call(factorial, { n: 5 }));
const { instance } = await Module({ exports: { run } }).instantiate();
instance.exports.run(); // 120
```

- **Locals** are a function's variables: its parameters, and the `locals` it declares, which start at zero, or null for references. Locals of non-null reference types must be set before they are read. `local.get`, `local.set` and `local.tee` (set, and keep the value on the stack) read and write them. `localArray(type, n)` declares several locals of one type.
- **Calls**: `call(f, { name: value })` passes arguments by parameter name; `call(f)` takes them from the stack.
- **Results** are the values left on the stack; `return_()` returns early.
- Function names come from the `name` option, a named callback, or the export key. They, and parameter and local names, go into the module's name section, so they show up in stack traces and in the text format.

## Generating code

Builder calls append instructions to the function being built, so a JS function that makes them emits its code into whichever function calls it. JS becomes the macro language of your Wasm: loops unroll, values known when the module is built become constants, and locals are passed around as arguments.

```ts
import { Module, func, i64, local, type Local } from "wasmati";

// emits x^n into the function that calls it; n is fixed when the module is built
function pow(result: Local<i64>, x: Local<i64>, n: number) {
  local.set(result, x);
  for (let bit of n.toString(2).slice(1)) {
    local.set(result, i64.mul(result, result));
    if (bit === "1") local.set(result, i64.mul(result, x));
  }
}

const pow13 = func({ in: [{ x: i64 }], locals: { r: i64 }, out: [i64] }, ({ x }, { r }) => {
  pow(r, x, 13);
  local.get(r);
});

const { instance } = await Module({ exports: { pow13 } }).instantiate();
instance.exports.pow13(2n); // 8192n
```

Libraries generate whole families of functions this way, from parameters like a modulus or a size. Generated code avoids calls but makes the module bigger; to share code at runtime instead, define a `func` and call it.

## Linear memory

A **memory** is a resizable array of bytes, which code reads and writes with load and store instructions at numeric addresses. Its size is counted in pages of 64 KiB. JS sees it as an `ArrayBuffer`, which makes memory the way to exchange bulk data with JS.

```ts
import { Module, func, memory, data, i32, local, block, loop, br_if, br } from "wasmati";

const mem = memory({ min: 1 }); // one page
data({ memory: mem, offset: 16 }, [1, 2, 3, 4]); // copied to bytes 16 to 19 when instantiated

const sumBytes = func(
  { in: [{ start: i32 }, { end: i32 }], locals: { sum: i32 }, out: [i32] },
  ({ start, end }, { sum }) => {
    block((done) => {
      loop((next) => {
        i32.ge_u(start, end);
        br_if(done);
        local.set(sum, i32.add(sum, i32.load8_u({}, start)));
        local.set(start, i32.add(start, 1));
        br(next);
      });
    });
    local.get(sum);
  },
);

const { instance } = await Module({ exports: { sumBytes, mem } }).instantiate();
new Uint8Array(instance.exports.mem.buffer)[20] = 5; // JS writes memory directly
instance.exports.sumBytes(16, 21); // 15
```

- Loads take a **memory argument** and the address; stores take a memory argument, the address and the value: `i32.store({}, address, value)`. The memory argument, `{ offset, align, memory }`, has a constant added to the address, an alignment hint in bytes, and the memory; `{}` means no offset, natural alignment, and the module's only memory. Narrow variants access fewer bytes: `i32.load8_u` loads one byte and zero-extends it, `i32.load8_s` sign-extends it, and `i32.store8` stores the lowest byte.
- Values are stored little-endian. Accesses need not be aligned, except atomic ones; alignment only hints at performance.
- `memory.size()` pushes a memory's size in pages, and `memory.grow()` grows it by the number of pages on the stack, pushing the old size, or -1 if it cannot grow. Growing replaces the memory's `ArrayBuffer`: JS must create its views, like `new Uint8Array(mem.buffer)`, again afterwards. `memory.copy`, `memory.fill` and `memory.init` work on byte ranges.
- **Data segments** initialize memory: active ones are copied at instantiation, passive ones, `data("passive", bytes)`, by `memory.init`.
- A module may have several memories. Memories created with `address: "i64"` have 64-bit addresses (memory64), so their addresses and sizes are `i64`. Instructions without a `memory` use the module's only memory, which must have 32-bit addresses; otherwise, they must name it.
- A memory with `shared: true` can be shared between workers, which synchronize with atomic instructions, like `i32.atomic.rmw.add` and `memory.atomic.wait32`.

## Globals and constant expressions

A **global** is a module-level variable, mutable or not, which can be exported or imported. Its initial value is a **constant expression**: a few instructions that can be evaluated before any code runs. wasmati builds them with the normal instruction API, inside `constant(() => ...)`.

```ts
import { Module, func, global, constant, i32 } from "wasmati";

const counter = global(
  constant(() => i32.const(0)),
  { mutable: true },
);
const limit = global(constant(() => i32.mul(10, 10))); // constants can add, subtract and multiply

const increment = func({ in: [], out: [i32] }, () => {
  global.set(counter, i32.add(global.get(counter), 1));
  global.get(counter);
});

const { instance } = await Module({ exports: { increment, limit } }).instantiate();
instance.exports.increment(); // 1
instance.exports.limit.value; // 100, read through a WebAssembly.Global
```

Constant expressions also give the offsets of data and element segments, where numbers work too, and the values that fill tables.

## Imports, exports and JS

```ts
import { Module, func, importFunc, importGlobal, i32, call, global } from "wasmati";

const log = importFunc({ in: [{ x: i32 }], out: [] }, (x) => console.log(x));
const base = importGlobal(i32, 100);

const f = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => {
  call(log, { x });
  i32.add(x, global.get(base));
});

const { instance } = await Module({ exports: { f } }).instantiate();
instance.exports.f(1); // logs 1, returns 101
```

- Imports declare their type together with their JS value: `importFunc`, `importGlobal`, `importMemory`, `importTable` and `importTag`. wasmati assembles the import object, which is also available as `module.importMap`. The `module` and `field` options set explicit import names.
- Exports are the keys of `exports`, and their types in `instance.exports` are inferred.
- Only what the exports and the `start` function need ends up in the module; the `dependencies` option adds more. The start function runs when the module is instantiated.
- Workers can instantiate a module that another thread compiled, without rebuilding it. Post the compiled module from `compile()` with the import object; this works while the imports can be posted, like a shared memory, but not JS functions. `Instance<typeof wasm>` types the result:

```ts
// main thread
const module = await wasm.compile();
worker.postMessage({ module, imports: wasm.importMap });

// worker
const { instance } = await WebAssembly.instantiate(module, imports);
const { exports } = instance as Instance<typeof wasm>;
```

## Tables and indirect calls

Functions do not live in linear memory, so there are no function pointers. To call functions by an integer index, store references to them in a **table**: `call_indirect` calls the function at an index of a table. The engine checks the function's type at runtime and traps on a mismatch. Tables implement function pointers and virtual methods, and **element segments** fill them.

```ts
import { Module, func, table, elem, funcref, call_indirect, i32, local } from "wasmati";

const double = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => i32.mul(x, 2));
const square = func({ in: [{ x: i32 }], out: [i32] }, ({ x }) => i32.mul(x, x));

const operations = table({ type: funcref, min: 2 });
elem({ type: funcref, mode: { table: operations, offset: 0 } }, [double, square]);

const apply = func({ in: [{ op: i32 }, { x: i32 }], out: [i32] }, ({ op, x }) => {
  local.get(x); // the argument
  local.get(op); // the index into the table
  call_indirect(operations, { in: [i32], out: [i32] });
});

const { instance } = await Module({ exports: { apply } }).instantiate();
instance.exports.apply(1, 7); // square(7) = 49
```

References to functions are also values: `ref.func(f)` makes one, and `call_ref(type)` calls it without a table. `return_call`, `return_call_indirect` and `return_call_ref` are tail calls, which replace the caller's stack frame.

## Garbage-collected data

Besides linear memory, Wasm can allocate **structs** and **arrays** that the engine manages and collects, like JS objects. Code refers to them through typed references, and there is no address arithmetic and no manual freeing. You define their types, allocate them with `struct.new` and `array.new`, and access fields by name.

```ts
import {
  Module,
  func,
  struct,
  array,
  rec,
  mut,
  i32,
  f64,
  refType,
  ref,
  local,
  call,
  block,
  loop,
  br,
  br_if,
} from "wasmati";

const point = struct({ x: f64, y: f64 });
const numbers = array(mut(i32)); // mut: elements can be set
// Types that refer to themselves or to each other are defined together.
const { node } = rec((types) => ({
  node: struct({ value: i32, next: refType(types.node, { nullable: true }) }),
}));
const list = refType(node, { nullable: true });

const lengthSquared = func({ in: [{ p: refType(point) }], out: [f64] }, ({ p }) => {
  f64.mul(struct.get(point, "x", p), struct.get(point, "x", p));
  f64.mul(struct.get(point, "y", p), struct.get(point, "y", p));
  f64.add();
});

const sum = func({ in: [{ l: list }], locals: { total: i32 }, out: [i32] }, ({ l }, { total }) => {
  block((done) => {
    loop((next) => {
      local.get(l);
      ref.is_null();
      br_if(done);
      local.set(total, i32.add(total, struct.get(node, "value", l)));
      local.set(l, struct.get(node, "next", l));
      br(next);
    });
  });
  local.get(total);
});

const main = func({ in: [], out: [f64, i32, i32] }, () => {
  call(lengthSquared, { p: struct.new(point, { x: 3, y: 4 }) });
  call(sum, {
    l: struct.new(node, { value: 1, next: struct.new(node, { value: 2, next: ref.null(list) }) }),
  });
  array.len(array.new_fixed(numbers, [1, 2, 3]));
});

const { instance } = await Module({ exports: { main } }).instantiate();
instance.exports.main(); // [25, 3, 3]
```

- `refType(type)` is a non-null reference; `refType(type, { nullable: true })` may be null. `ref.null(referenceType)` creates a null reference, and `ref.is_null()` tests for one. Using a null reference traps.
- JS cannot create structs or arrays, nor read their fields: export functions that do.
- `struct({ ... })` defines fields in order. `mut(type)` makes a field mutable, so that `struct.set(type, "field", reference, value)` can write it. `i8` and `i16` are packed integer fields, read with `get_s` or `get_u`. Field reads and writes have the field's type, also in TypeScript.
- Arrays: `array.new(type, value, length)`, `new_default`, `new_fixed`, `get`, `set`, `len`, `fill` and `copy`.
- **Subtyping**: types are final unless defined with `{ final: false }`, and a subtype adds fields at the end: `struct({ x: f64, y: f64, z: f64 }, { supertype: point })`, where `point` is not final. A reference to a subtype can be used where the supertype is expected. `ref.test(type)` checks a reference's runtime type, `ref.cast(type)` casts it, trapping if it fails, and `br_on_cast` branches on the result.
- Abstract reference types sit above all defined types: `anyref` holds any GC value, `eqref` those comparable with `ref.eq`, `structref` and `arrayref`, and `i31ref` small integers stored in a reference (`ref.i31`). `externref` holds JS values, which `any.convert_extern` and `extern.convert_any` move between the two worlds.
- Equivalent types are the same type, and `rec` groups are compared as a whole, as Wasm's type system defines.

## Exceptions

Wasm exceptions carry values described by a **tag**. `throw_(tag)` throws with values from the stack. `try_table` catches exceptions from its body: each catch clause names a tag and an enclosing label, where execution continues with the exception's values.

```ts
import { Module, func, tag, throw_, try_table, block, i32 } from "wasmati";

const failure = tag({ in: [i32] });

const f = func({ in: [], out: [i32] }, () => {
  block({ out: [i32] }, (caught) => {
    try_table({ catches: [{ tag: failure, label: caught }] }, () => {
      i32.const(42);
      throw_(failure);
    });
    i32.const(0); // not reached
  });
});

const { instance } = await Module({ exports: { f } }).instantiate();
instance.exports.f(); // 42
```

A clause without `tag` catches every exception, including JS ones; with `ref: true`, it adds a reference to the exception, which `throw_ref` rethrows. Uncaught exceptions arrive in JS as `WebAssembly.Exception`.

## Waiting for async JS

Wasm code runs synchronously, but it can wait for async JS through JS Promise Integration (JSPI). An async import may return a promise: Wasm suspends until the promise resolves, then continues with its value. JS must enter such code through an async export, which returns a promise.

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

Functions in between stay ordinary functions: the engine suspends the whole Wasm stack. JSPI is new in engines; [webassembly.org/features](https://webassembly.org/features/) lists which support it. `Module` throws if an export that is not async, or the start function, can reach an async import through direct calls. Through indirect calls, the call throws `WebAssembly.SuspendError` instead.

## JS strings

Strings stay JS strings, held as `externref`. The JS string builtins are imports that the engine implements efficiently: `jsString.length`, `charCodeAt`, `concat`, `substring`, `equals`, and others. `stringConstant(text)` imports a string constant.

```ts
import { Module, func, call, jsString, stringConstant, externref, global } from "wasmati";

const hello = stringConstant("hello ");
const greet = func({ in: [{ name: externref }], out: [externref] }, ({ name }) =>
  call(jsString.concat, { first: global.get(hello), second: name }),
);

const { instance } = await Module({ exports: { greet } }).instantiate();
instance.exports.greet("wasmati"); // "hello wasmati"
```

Engines without the builtins use their JS versions, which behave the same. `jsString.charCodeArray` is the array type of `fromCharCodeArray` and `intoCharCodeArray`, which convert between strings and arrays of UTF-16 code units.

## SIMD

`v128` values hold several lanes: sixteen `i8`, eight `i16`, four `i32` or `f32`, or two `i64` or `f64`. Each lane shape has a namespace, from `i8x16` to `f64x2`, whose instructions work on all lanes at once.

```ts
import { Module, func, v128, i32x4, i32 } from "wasmati";

const f = func({ in: [], out: [i32] }, () => {
  v128.const("i32x4", [1, 2, 3, 4]);
  v128.const("i32x4", [10, 20, 30, 40]);
  i32x4.add();
  i32x4.extract_lane(3);
});

const { instance } = await Module({ exports: { f } }).instantiate();
instance.exports.f(); // 44
```

## The text format and decompiling

- `Module.fromWat(text)` reads a module in the text format, and `module.toWat()` prints one. `Module.fromBytes(bytes)` and `module.toBytes()` do the same with the binary format.
- `decompile(bytesOrWat)` turns any module into wasmati TypeScript, whose default export builds the module from an import object. Decompiling Wasm written elsewhere is a good way to see how its constructs look in wasmati.
- The CLI does the same with files: `wasmati decompile input.wasm -o output.ts`, `wasmati wat input.wasm`, and `wasmati wasm input.wat -o output.wasm`. Every command takes either format.

## Shipping without wasmati

`wasmati build file.ts -o dir` turns a file that default-exports a `Module` into `dir/file.wasm`. JS imports it directly, `import { f } from "./dir/file.wasm"`, through the ESM integration of Wasm, without wasmati at runtime.

- Export types go to `file.d.wasm.ts`, which TypeScript reads with the `allowArbitraryExtensions` option.
- Imports written inline are extracted into `file.host.js`, together with the top-level declarations and imports they use. The built file may only export its `Module`; state that the app shares with the imports belongs in another module.
- The build rejects files it cannot copy faithfully, and its error says why: for example, an import function that uses a variable of an enclosing function, which only exists while the module is built.
- With async exports, JS imports the generated `file.entry.ts` instead, which wraps them.
- Built modules run in Node 22.19, 24.5 and later and in Deno 2.1 and later. Browsers need a bundler: Vite with `vite-plugin-wasm`, or Next.js with Turbopack. Modules that use JS string builtins also need the bundler to map `wasm:js-string` to the generated `js-string.js`.

## Debugging

- Read the error: wasmati names the instruction and the types involved, and the stack trace points to your builder call.
- Print `module.toWat()` to see the instructions you produced.
- Traps throw `WebAssembly.RuntimeError` from the exported function you called, with a stack trace that includes Wasm function names.
- Common mistakes: leaving values on the stack at the end of a function or block, passing numbers where `i64` expects bigints, passing instruction results in another order than they were computed, not naming the memory when there are several or it is 64-bit, keeping JS views of a memory that has grown, and exporting a function that reaches an async import without `async(...)`.
- JS calling an export with a value that does not fit a reference parameter, like `null` for a non-null reference, gets a `TypeError` from the engine.

## Performance

The module contains exactly the instructions you write, so it is as fast as those instructions, once the engine compiles them. Notes for V8, the engine of Chrome, Node and Deno:

- V8 compiles functions quickly first, and recompiles hot ones with its optimizing compiler. Benchmarks need to run long enough for that, and should measure both latency, where each operation waits for the previous one, and throughput, where operations are independent.
- `node --no-liftoff --no-wasm-lazy-compilation --print-wasm-code` prints the optimized machine code. Moves to and from the stack frame are spills: more values were live than fit in registers.
- Calls between JS and Wasm cost a few nanoseconds each. In hot loops, loop inside Wasm and pass arrays in memory.
- Fusing code into one function by generating it saves calls, up to the point where its values no longer fit in registers.
- Branches on unpredictable data are slow; `select()` avoids them. For rare paths, a branch with a hint, `br_if(label, { likely: false })`, is cheaper.

## Further reading

- [WebAssembly specification](https://webassembly.github.io/spec/core/): the [instructions](https://webassembly.github.io/spec/core/syntax/instructions.html) and their [index](https://webassembly.github.io/spec/core/appendix/index-instructions.html), and the [JS API](https://webassembly.github.io/spec/js-api/).
- [MDN WebAssembly reference](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference) and its guide to the [text format](https://developer.mozilla.org/en-US/docs/WebAssembly/Guides/Understanding_the_text_format).
- [webassembly.org/features](https://webassembly.org/features/): Wasm features and proposals, and which engines support them.
