import { type Type, type ValueType, valueTypeLiteral } from "./types.ts";

export { params, type Parameters, type ParameterEntry, type ParameterTypes, type ParameterValues };

type ParameterEntry = Record<string, Type<ValueType>>;
type IsUnion<T, Whole = T> = T extends Whole ? [Whole] extends [T] ? false : true : never;
type OneKey<E> = keyof E extends never ? never
  : [keyof E] extends [string | number] ? IsUnion<keyof E> extends true ? never : E : never;
type TextKeys<E> = `${Extract<keyof E, string | number>}`;
type Unique<P extends readonly ParameterEntry[], Seen = never> =
  P extends readonly [infer H extends ParameterEntry, ...infer R extends readonly ParameterEntry[]]
    ? Extract<TextKeys<H>, Seen> extends never ? Unique<R, Seen | TextKeys<H>> : never
    : unknown;
type ParameterTypes<P extends readonly ParameterEntry[]> = {
  -readonly [K in keyof P]: P[K][keyof P[K]]["kind"];
};
type ParameterValues<P extends readonly ParameterEntry[]> = {
  [E in P[number] as keyof E]: E[keyof E]["kind"];
};
// Keep only names and value types, rather than carrying entire instruction APIs in inferred signatures.
type ParameterSchema<P extends readonly ParameterEntry[]> = {
  [K in keyof P]: { [Name in keyof P[K] as Name extends string | number ? `${Name}` : never]: Type<P[K][Name]["kind"]> };
};
type Parameters<P extends readonly ParameterEntry[] = readonly ParameterEntry[]> = {
  names: string[];
  types: ParameterTypes<P>;
  values: ParameterValues<P>;
};

/**
 * Declare parameters in ABI order, with one named type per entry: params({ x: i32 }, { y: i64 }).
 * The ordered tuple retains native JS argument types and arity; names supply callback keys and Wasm metadata.
 * Empty/multi-key entries and duplicate names are rejected. params() declares an empty signature.
 */
function params<const P extends readonly ParameterEntry[]>(
  ...entries: P & { [K in keyof P]: OneKey<P[K]> } & Unique<P>
): Parameters<ParameterSchema<P>> {
  const names: string[] = [];
  const types: ValueType[] = [];
  for (const entry of entries) {
    const keys = Object.keys(entry);
    if (keys.length !== 1) throw Error("params: each entry must have exactly one name");
    const name = keys[0];
    if (names.includes(name)) throw Error(`params: duplicate name ${name}`);
    names.push(name);
    types.push(valueTypeLiteral(entry[name]));
  }
  return {
    names,
    types: types as ParameterTypes<ParameterSchema<P>>,
    values: Object.fromEntries(names.map((name, index) => [name, types[index]])) as ParameterValues<ParameterSchema<P>>,
  };
}
