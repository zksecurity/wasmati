import { type Type, type ValueType, valueTypeLiteral } from "./types.ts";

export {
  createParameters,
  type Parameters,
  type ParameterEntry,
  type ParameterInput,
  type ParameterSchema,
  type CheckedParameters,
  type ParameterTypes,
  type ParameterValues,
};

type ParameterEntry = Record<string, ValueType>;
type ParameterInput = Record<string, Type<ValueType>>;
type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;
type OneKey<E> = keyof E extends never
  ? never
  : [keyof E] extends [string | number]
    ? IsUnion<keyof E> extends true
      ? never
      : E
    : never;
type TextKeys<E> = `${Extract<keyof E, string | number>}`;
type Unique<P extends readonly ParameterInput[], Seen = never> = P extends readonly [
  infer H extends ParameterInput,
  ...infer R extends readonly ParameterInput[],
]
  ? Extract<TextKeys<H>, Seen> extends never
    ? Unique<R, Seen | TextKeys<H>>
    : never
  : unknown;
type ParameterTypes<P extends readonly ParameterEntry[]> = {
  -readonly [K in keyof P]: Extract<P[K][keyof P[K]], ValueType>;
};
type ParameterValues<P extends readonly ParameterEntry[]> = {
  [E in P[number] as keyof E]: Extract<E[keyof E], ValueType>;
};
// Keep only names and value types, rather than carrying entire instruction APIs in inferred signatures.
type ParameterSchema<P extends readonly ParameterInput[]> = {
  [K in keyof P]: {
    [Name in keyof P[K] as Name extends string | number ? `${Name}` : never]: P[K][Name]["kind"];
  };
};
/** Parameter metadata for an ordered schema such as [{ x: "i32" }, { y: "i64" }]. */
type Parameters<P extends readonly ParameterEntry[] = readonly ParameterEntry[]> = {
  names: string[];
  types: ParameterTypes<P>;
  values: ParameterValues<P>;
};

/** Require one named type per entry, with no repeated names in an ordered tuple. */
type CheckedParameters<P extends readonly ParameterInput[]> = P & {
  [K in keyof P]: OneKey<P[K]>;
} & Unique<P>;

/** Build function metadata from ordered parameter inputs; validate names for callers from untyped JS. */
function createParameters<const P extends readonly ParameterInput[]>(
  entries: P,
): Parameters<ParameterSchema<P>> {
  const names: string[] = [];
  const types: ValueType[] = [];
  for (const entry of entries) {
    const keys = Object.keys(entry);
    if (keys.length !== 1)
      throw Error("function parameters: each entry must have exactly one name");
    const name = keys[0];
    if (names.includes(name)) throw Error(`function parameters: duplicate name ${name}`);
    names.push(name);
    types.push(valueTypeLiteral(entry[name]));
  }
  return {
    names,
    types: types as ParameterTypes<ParameterSchema<P>>,
    values: Object.fromEntries(names.map((name, index) => [name, types[index]])) as ParameterValues<
      ParameterSchema<P>
    >,
  };
}
