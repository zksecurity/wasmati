import { localArray, params, Module, call, func, i32, i64, importFunc, local, type Func, type Local, type StackVar } from "../index.ts";

// Checked by tsc, never executed: negative cases must fail at compile time.
async function checkNamedFunctionTypes() {
  const mixed = func(
    { in: params({ small: i32 }, { large: i64 }, { another: i32 }), locals: { scratch: i64, limbs: localArray(i64, 5) }, out: [i64] },
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
  func({ in: params(), out: [i64] }, () => {
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
  importFunc({ in: params({ value: i64 }), out: [i64] }, (value) => {
    value satisfies bigint;
    return value;
  });
  // @ts-expect-error import result type must match its Wasm signature
  importFunc({ in: params({ value: i64 }), out: [i64] }, () => 42);
  // @ts-expect-error positional declarations have been replaced
  func({ in: [i32], out: [] }, () => {});
  // @ts-expect-error named callbacks cannot access undeclared parameters
  func({ in: params({ value: i32 }), out: [] }, ({ missing }) => {});
  const nothing = func({ in: params(), out: [] }, () => {});
  const empty = await Module({ exports: { nothing } }).instantiate();
  empty.instance.exports.nothing() satisfies void;
  // @ts-expect-error an empty signature takes no JS arguments
  empty.instance.exports.nothing(1);
  // @ts-expect-error parameter entries need exactly one key
  params({ x: i32, y: i64 });
  // @ts-expect-error empty parameter entries are rejected
  params({});
  // @ts-expect-error duplicate names are rejected
  params({ x: i32 }, { x: i64 });
  // @ts-expect-error numeric and string keys denote the same name
  params({ 1: i32 }, { "1": i64 });
  // @ts-expect-error Wasm parameter names must be text keys
  params({ [Symbol.iterator]: i32 });
  const binary = params({ z: i32 }, { x: i32 }, { y: i32 });
  const typed: Func<typeof binary, []> = func({ in: binary, out: [] }, () => {});
  func({ in: params(), out: [] }, () => {
    call(typed, { y: 3, x: 2, z: 1 });
    // @ts-expect-error reusable signature types preserve required callback keys
    call(typed, { x: 2, y: 3 });
  });
  const count: number = 5;
  func({ in: params(), locals: { limbs: localArray(i64, count) }, out: [] }, (_, { limbs }) => {
    limbs satisfies Local<i64>[];
  });
  const pair = func({ in: params({ value: i64 }), out: [i64, i64] }, ({ value }) => {
    local.get(value);
    local.get(value);
  });
  const result = await Module({ exports: { pair } }).instantiate();
  result.instance.exports.pair(1n) satisfies [bigint, bigint];
}
