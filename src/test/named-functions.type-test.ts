import {
  localArray,
  Module,
  call,
  func,
  i32,
  i64,
  importFunc,
  local,
  type Func,
  type ImportFunc,
  type AnyFunc,
  type Parameters,
  type Local,
  type StackVar,
} from "../index.ts";

// Checked by tsc, never executed: negative cases must fail at compile time.
async function checkNamedFunctionTypes() {
  const mixed = func(
    {
      in: [{ small: i32 }, { large: i64 }, { another: i32 }],
      locals: { scratch: i64, limbs: localArray(i64, 5) },
      out: [i64],
    },
    ({ small, large, another }, { scratch, limbs }) => {
      small satisfies Local<i32>;
      another satisfies Local<i32>;
      large satisfies Local<i64>;
      scratch satisfies Local<i64>;
      limbs satisfies [Local<i64>, Local<i64>, Local<i64>, Local<i64>, Local<i64>];
      // @ts-expect-error grouped locals preserve their element type
      limbs[0] satisfies Local<i32>;
      // @ts-expect-error literal-sized local groups retain their length
      limbs[5];
      // @ts-expect-error parameters keep their distinct value types
      i32.add(small, large);
      // @ts-expect-error locals retain their declared types
      local.set(scratch, small);
      local.get(large);
    },
  );
  func({ in: [], out: [i64] }, () => {
    call(mixed, { another: 3, large: 2n, small: 1 }) satisfies StackVar<i64>;
    // @ts-expect-error missing a required named parameter
    call(mixed, { small: 1, large: 2n });
    // @ts-expect-error unknown named parameter
    call(mixed, { small: 1, large: 2n, another: 3, extra: 4 });
    // @ts-expect-error i64 input needs bigint or a matching Wasm value
    call(mixed, { small: 1, large: 2, another: 3 });
    // @ts-expect-error positional builder arguments have been replaced
    call(mixed, [1, 2n, 3]);
  });
  const { instance } = await Module({ exports: { mixed } }).instantiate();
  instance.exports.mixed(1, 2n, 3) satisfies bigint;
  // @ts-expect-error mixed JS parameter types are preserved
  instance.exports.mixed(1, 2, 3);
  // @ts-expect-error missing native JS parameter
  instance.exports.mixed(1, 2n);
  // @ts-expect-error extra native JS parameter
  instance.exports.mixed(1, 2n, 3, 4);
  // @ts-expect-error native JS arguments retain their declaration order
  instance.exports.mixed(1n, 2, 3);
  importFunc({ in: [{ value: i64 }], out: [i64] }, (value) => {
    value satisfies bigint;
    return value;
  });
  // @ts-expect-error import result type must match its Wasm signature
  importFunc({ in: [{ value: i64 }], out: [i64] }, () => 42);
  // @ts-expect-error positional declarations have been replaced
  func({ in: [i32], out: [] }, () => {});
  // @ts-expect-error named callbacks cannot access undeclared parameters
  func({ in: [{ value: i32 }], out: [] }, ({ missing }) => {});
  const nothing = func({ in: [], out: [] }, () => {});
  const empty = await Module({ exports: { nothing } }).instantiate();
  empty.instance.exports.nothing() satisfies void;
  // @ts-expect-error an empty signature takes no JS arguments
  empty.instance.exports.nothing(1);
  // @ts-expect-error parameter entries need exactly one key
  func({ in: [{ x: i32, y: i64 }], out: [] }, () => {});
  // @ts-expect-error empty parameter entries are rejected
  func({ in: [{}], out: [] }, () => {});
  // @ts-expect-error duplicate names are rejected
  func({ in: [{ x: i32 }, { x: i64 }], out: [] }, () => {});
  // @ts-expect-error numeric and string keys denote the same name
  func({ in: [{ 1: i32 }, { "1": i64 }], out: [] }, () => {});
  // @ts-expect-error Wasm parameter names must be text keys
  func({ in: [{ [Symbol.iterator]: i32 }], out: [] }, () => {});
  // @ts-expect-error imports require one unique name per entry too
  importFunc({ in: [{ x: i32 }, { x: i64 }], out: [] }, () => {});
  mixed satisfies Func<[{ small: "i32" }, { large: "i64" }, { another: "i32" }], ["i64"]>;
  const binary = [{ z: i32 }, { x: i32 }, { y: i32 }] as const;
  mixed.params satisfies Parameters<[{ small: "i32" }, { large: "i64" }, { another: "i32" }]>;
  const typed: Func<[{ z: "i32" }, { x: "i32" }, { y: "i32" }], []> = func(
    { in: binary, out: [] },
    () => {},
  );
  // @ts-expect-error annotations preserve ABI order and each parameter's type
  mixed satisfies Func<[{ large: "i64" }, { small: "i32" }, { another: "i32" }], ["i64"]>;
  // @ts-expect-error parameter schemas require valid Wasm value types
  type Invalid = Func<[{ x: "invalid" }], []>;
  const imported: ImportFunc<[{ small: "i32" }, { large: "i64" }], ["i64"]> = importFunc(
    { in: [{ small: i32 }, { large: i64 }], out: [i64] },
    (small, large) => {
      small satisfies number;
      large satisfies bigint;
      return large;
    },
  );
  const either: AnyFunc<[{ small: "i32" }, { large: "i64" }], ["i64"]> = imported;
  func({ in: [], out: [i64] }, () => {
    call(either, { small: 1, large: 2n }) satisfies StackVar<i64>;
    // @ts-expect-error explicit import annotations preserve named operand types
    call(either, { small: 1, large: 2 });
  });
  const nativeImport = await Module({ exports: { imported } }).instantiate();
  nativeImport.instance.exports.imported(1, 2n) satisfies bigint;
  // @ts-expect-error explicit import annotations preserve native argument order
  nativeImport.instance.exports.imported(1n, 2);
  func({ in: [], out: [] }, () => {
    call(typed, { y: 3, x: 2, z: 1 });
    // @ts-expect-error reusable signature types preserve required callback keys
    call(typed, { x: 2, y: 3 });
  });
  const count: number = 5;
  func({ in: [], locals: { limbs: localArray(i64, count) }, out: [] }, (_, { limbs }) => {
    limbs satisfies Local<i64>[];
  });
  const pair = func({ in: [{ value: i64 }], out: [i64, i64] }, ({ value }) => {
    local.get(value);
    local.get(value);
  });
  const result = await Module({ exports: { pair } }).instantiate();
  result.instance.exports.pair(1n) satisfies [bigint, bigint];
}
