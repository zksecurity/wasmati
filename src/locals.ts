import type { Local, Type, ValueType } from "./types.ts";
import type { TupleN } from "./util.ts";

export { localArray, type LocalArray, type LocalDeclaration, type NamedLocals };

type LocalArray<T extends ValueType = ValueType, N extends number = number> = {
  kind: "local-array";
  type: Type<T>;
  length: N;
};
type LocalDeclaration = Type<ValueType> | LocalArray;
type NamedLocals<L extends Record<string, LocalDeclaration>> = {
  [K in keyof L]: L[K] extends Type<infer T extends ValueType>
    ? Local<T>
    : L[K] extends LocalArray<infer T, infer N>
      ? TupleN<Local<T>, N>
      : never;
};

/**
 * Declare a group of same-typed locals. localArray(i64, 5) gives the callback a five-element Local<i64> tuple;
 * a dynamic length gives Local<i64>[]. Group entries receive debug names such as Y[0], Y[1].
 * The function builder flattens and groups locals by Wasm type, then reconstructs the named callback groups.
 */
function localArray<T extends ValueType, const N extends number>(
  type: Type<T>,
  length: N,
): LocalArray<T, N> {
  if (!Number.isSafeInteger(length) || length < 0)
    throw Error("localArray: length must be a non-negative integer");
  return { kind: "local-array", type, length };
}
