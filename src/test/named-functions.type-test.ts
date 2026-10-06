import { Module, call, func, i32, i64, importFunc, local, type Local, type StackVar } from "../index.ts";

// Checked by tsc, never executed: negative cases must fail at compile time.
async function checkNamedFunctionTypes() {
  const mixed = func(
    { in: { small: i32, large: i64, another: i32 }, locals: { scratch: i64 }, out: [i64] },
    ({ small, large, another }, { scratch }) => {
      small satisfies Local<i32>;
      another satisfies Local<i32>;
      large satisfies Local<i64>;
      scratch satisfies Local<i64>;
      // @ts-expect-error parameters keep their distinct value types
      i32.add(small, large);
      // @ts-expect-error locals retain their declared types
      local.set(scratch, small);
      local.get(large);
    },
  );
  func({ in: {}, out: [i64] }, () => {
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
  const { exports } = await Module({ exports: { mixed } }).instantiate();
  exports.mixed({ large: 2n, another: 3, small: 1 }) satisfies bigint;
  // @ts-expect-error mixed JS parameter types are preserved
  exports.mixed({ small: 1, large: 2, another: 3 });
  // @ts-expect-error missing named JS parameter
  exports.mixed({ small: 1, large: 2n });
  // @ts-expect-error unknown named JS parameter
  exports.mixed({ small: 1, large: 2n, another: 3, extra: 4 });
  // @ts-expect-error positional JS arguments have been replaced
  exports.mixed(1, 2n, 3);
  importFunc({ in: { value: i64 }, out: [i64] }, ({ value }) => {
    value satisfies bigint;
    return value;
  });
  // @ts-expect-error import result type must match its Wasm signature
  importFunc({ in: { value: i64 }, out: [i64] }, () => 42);
  // @ts-expect-error positional declarations have been replaced
  func({ in: [i32], out: [] }, () => {});
  // @ts-expect-error named callbacks cannot access undeclared parameters
  func({ in: { value: i32 }, out: [] }, ({ missing }) => {});
  const nothing = func({ in: {}, out: [] }, () => {});
  const empty = await Module({ exports: { nothing } }).instantiate();
  empty.exports.nothing() satisfies void;
  // @ts-expect-error an empty signature takes no JS arguments
  empty.exports.nothing({ extra: 1 });
  const pair = func({ in: { value: i64 }, out: [i64, i64] }, ({ value }) => {
    local.get(value);
    local.get(value);
  });
  const result = await Module({ exports: { pair } }).instantiate();
  result.exports.pair({ value: 1n }) satisfies [bigint, bigint];
}
