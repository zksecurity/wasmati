# wasmati

> Write low-level WebAssembly from JavaScript

This is the beginnings of a fully-featured Wasm DSL for TS.

## Goals:

- **Write low-level Wasm from TS**
- API directly corresponds to Wasm opcodes, like `i32.add` etc

- **Readability.** Wasm code should look imperative - like writing WAT by hand, just with better DX:

```ts
const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  local.get(x);
  local.get(y);
  i32.add();
  i32.const(2);
  i32.shl();
  call(otherFunction);
});
```

- Optional syntax sugar to reduce boilerplate assembly like `local.get` and `i32.const`

```ts
const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  i32.add(x, y); // local.get(x), local.get(y) are filled in
  i32.shl($, 2); // $ is the top of the stack; i32.const(2) is filled in
  call(otherFunction);
});

// or maybe also

const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  let z = i32.add(x, y);
  call(otherFunction, [i32.shl(z, 2)]);
});
```

- **Type-safe.** Example: Local variables are typed; instructions know their input types:

```ts
const myFunction = func({ in: [i64, i32], out: [i32] }, ([x, y]) => {
  i32.add(x, y); // type error: "Argument of type 'i64' is not assignable to parameter of type 'i32'."
});
```

- **Great debugging DX.** Example: Stack traces point to the exact line in your code where the invalid opcode is called:

```
Error: i32.add: expected i32 on the stack for first argument, got i64
    at file:///home/gregor/code/wasm-generate/example.ts:16:9
```

- **Trivial construction of modules.** Just declare exports; dependencies and imports are collected for you:

```ts
let mem = memory({ min: 10 });

let module = Module({ exports: { myFunction, mem } });
let instance = await module.instantiate();
```

- **Excellent type inference.** Example: Exported function types are inferred from `func` definitions:

```ts
instance.exports.myFunction;
//                 ^ (arg_0: number, arg_1: number) => number
```

- **Atomic import declaration.** Imports are declared as types along with their JS values. Abstracts away the global "import object" that is separate from "import declaration".

```ts
const consoleLog = importFunc({ in: [i32], out: [] }, (x) =>
  console.log("logging from wasm:", x)
);

const myFunction = func({ in: [i32, i32], out: [i32] }, ([x, y]) => {
  call(consoleLog, [x]);
  i32.add(x, y);
});
```

- Optional **build step** which takes as input a file that exports your `Module`, and compiles it to a file which hard-codes the Wasm bytecode as base64 string, correctly imports all dependencies (imports) for the instantiation like the original file did, instantiates the module (top-level await) and exports the module's exports.

```ts
// example.ts
let module = Module({ exports: { myFunction, mem } });

export { module as default };
```

```ts
import { myFunction } from "./example.wasm.js"; // example.wasm.js does not depend on this lib at runtime
```

- Excellent composability and IO
  - Internal representation of modules / funcs / etc is a readable JSON object
    - close to [the spec's type layout](https://webassembly.github.io/spec/core/syntax/modules.html#modules) (but improves readability or JS ergonomics where necessary)
  - Helpers like `module.toJSON`, `Module.fromJSON(json, imports)`
  - `toBytes`, `fromBytes`, `toBase64`, `fromBase64`

### Some ideas that are a bit further out:

- **Decompiler**: take _any_ Wasm file and create TS DSL code from it, to modify it, debug it etc
- **Source maps**, so you can look at the culprit JS code when Wasm throws an error
- Optional JS interpreter which can take DSL code and execute it _in JS_
  - could enable even more flexible debugging -- inspect the stack, global/local scope etc
