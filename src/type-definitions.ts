import { type FunctionTypeInput, typeFromInput } from "./instruction/base.ts";
import {
  type CompositeType,
  type DefinedType,
  type FieldType,
  referencedTypes,
  type StorageType,
  type Type,
} from "./types.ts";

export {
  struct,
  array,
  funcType,
  rec,
  mut,
  i8,
  i16,
  type FieldInput,
  type TypeOptions,
  type StructType,
  type ArrayType,
  type FieldValue,
};

/** Packed integer types, for struct fields and array elements. */
const i8: Type<"i8"> = { kind: "i8" };
const i16: Type<"i16"> = { kind: "i16" };

/** A field type: a storage type, made mutable with `mut`. */
type FieldInput = Type<StorageType> | { kind: StorageType; mutable: true };

function mut<T extends StorageType>(type: Type<T>): { kind: T; mutable: true } {
  return { kind: type.kind, mutable: true };
}

/**
 * Struct and array types record the types of their fields for TypeScript, which types the values that
 * GC instructions read and write. This is a type only: the properties do not exist at runtime.
 */
declare const fieldTypes: unique symbol;
declare const elementType: unique symbol;
type StructType<Fields extends Record<string, FieldInput> = Record<string, FieldInput>> =
  DefinedType & { readonly [fieldTypes]?: Fields };
type ArrayType<Element extends FieldInput = FieldInput> = DefinedType & {
  readonly [elementType]?: Element;
};

/** The type of a field's values: packed integers are read and written as i32. */
type FieldValue<F extends FieldInput> = F["kind"] extends "i8" | "i16"
  ? "i32"
  : Exclude<F["kind"], "i8" | "i16">;

/** A field type as written, without the instruction namespaces of types like `i32`. */
type Field<F extends FieldInput> = F extends { mutable: true }
  ? { kind: F["kind"]; mutable: true }
  : Type<F["kind"]>;

function field(input: FieldInput): FieldType {
  return { type: input.kind, mutable: "mutable" in input };
}

/** Types are final unless `final: false`, and may extend a non-final supertype. */
type TypeOptions = { final?: boolean; supertype?: DefinedType; name?: string };

function defined(
  composite: CompositeType,
  { final = true, supertype, name }: TypeOptions,
  fieldNames?: string[],
): DefinedType {
  const type = {
    ...composite,
    ...(final ? {} : { final: false as const }),
    ...(supertype === undefined ? {} : { supertype }),
  };
  return {
    kind: "type",
    type,
    deps: referencedTypes(type),
    ...(name === undefined ? {} : { name }),
    ...(fieldNames === undefined ? {} : { fieldNames }),
  };
}

/** A struct type with named fields, in order. */
function struct<const Fields extends Record<string, FieldInput>>(
  fields: Fields,
  options: TypeOptions = {},
): StructType<{ [K in keyof Fields]: Field<Fields[K]> }> {
  const entries = Object.entries(fields);
  return defined(
    { struct: entries.map(([, input]) => field(input)) },
    options,
    entries.map(([name]) => name),
  );
}

/** An array type of the given element type. */
function array<const Element extends FieldInput>(
  element: Element,
  options: TypeOptions = {},
): ArrayType<Field<Element>> {
  return defined({ array: field(element) }, options);
}

/** A function type with an identity, such as a subtype or a type of a recursion group. */
function funcType(signature: FunctionTypeInput, options: TypeOptions = {}): DefinedType {
  return defined(typeFromInput(signature), options);
}

/**
 * A recursion group, whose types may refer to each other and to themselves through `types`. The order
 * of the returned keys is the order of the group, and keys name the types.
 */
function rec<T extends Record<string, DefinedType>>(
  define: (types: { [K in keyof T]: DefinedType }) => T,
): T {
  const placeholders = new Map<string, DefinedType>();
  const placeholder = (key: string) => {
    let type = placeholders.get(key);
    if (type === undefined)
      placeholders.set(key, (type = { kind: "type", type: {} as any, deps: [] }));
    return type;
  };
  const types = new Proxy({}, { get: (_, key) => placeholder(String(key)) });
  const definitions = define(types as { [K in keyof T]: DefinedType });
  for (const key of placeholders.keys())
    if (!(key in definitions)) throw Error(`rec: type ${key} is referred to but not defined`);
  const group: DefinedType[] = [];
  for (const [key, definition] of Object.entries(definitions)) {
    // Members are the placeholders that other types refer to, completed with their definitions.
    const type = placeholder(key);
    Object.assign(type, definition, { group, name: definition.name ?? key });
    group.push(type);
  }
  return Object.fromEntries(group.map((type, i) => [Object.keys(definitions)[i], type])) as T;
}
