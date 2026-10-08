import { Binable, tuple, writeByte } from "../binable.ts";
import type * as Dependency from "../dependency.ts";
import { U32 } from "../immediate.ts";
import {
  getFrameFromLabel,
  type Label,
  labelTypes,
  type LocalContext,
  popStack,
  checkStack,
  type StackVar,
  pushStack,
  pushResult,
  isStackVar,
  Unknown,
} from "../local-context.ts";
import {
  type AbstractHeapType,
  DataIndex,
  type DefinedType,
  ElemIndex,
  type FieldType,
  HeapType,
  isHeapSubtype,
  isRefType,
  isSubtype,
  printValueType,
  referenced,
  refType,
  type RefType,
  type StorageType,
  type Type,
  TypeIndex,
  type ValueType,
  valueTypeLiteral,
  arrayref,
  eqref,
  i31ref,
  i32t,
} from "../types.ts";
import { checkAllowed, define, emitInstruction, withPublicSignature } from "./base.ts";
import type { ArrayType, FieldInput, FieldValue, StructType } from "../type-definitions.ts";
import {
  fixed,
  type Input,
  namedInputs,
  takeOne,
  takeOperands,
  typedByImmediates,
  writeOpcode,
} from "./stack-args.ts";

export {
  structOps,
  arrayOps,
  i31Ops,
  gcRefOps,
  anyOps,
  externOps,
  br_on_cast,
  br_on_cast_fail,
  instructions,
};

/** Packed fields are read and written as i32. */
function unpacked(type: StorageType): ValueType {
  return type === "i8" || type === "i16" ? "i32" : type;
}

function structFields(type: DefinedType): FieldType[] {
  if (!("struct" in type.type)) throw Error(`expected a struct type, got ${type.name ?? "a type"}`);
  return type.type.struct;
}

/** A field by name, as the struct type was defined, or by index. */
function fieldIndex(type: DefinedType, field: string | number): number {
  let fields = structFields(type);
  let index = typeof field === "number" ? field : (type.fieldNames?.indexOf(field) ?? -1);
  if (index < 0 || index >= fields.length) throw Error(`struct has no field ${field}`);
  return index;
}

function arrayElement(type: DefinedType): FieldType {
  if (!("array" in type.type)) throw Error(`expected an array type, got ${type.name ?? "a type"}`);
  return type.type.array;
}

function nullableRef(type: DefinedType) {
  return refType(type, true);
}

type Operand = Input<ValueType>;

type Fields = Record<string, FieldInput>;
type Ref = Input<RefType>;
/** Values of a field: its type where the struct type records its fields, any value otherwise. */
type FieldOf<F extends Fields, K extends keyof F> = string extends keyof F ? any : FieldValue<F[K]>;
type ElementOf<E extends FieldInput> = FieldInput extends E ? any : FieldValue<E>;

type StructNew = <F extends Fields>(
  type: StructType<F>,
  fields?: { [K in keyof F]: Input<FieldOf<F, K>> },
) => StackVar<RefType>;
type StructGet<Result = never> = <F extends Fields, K extends keyof F & string>(
  type: StructType<F>,
  field: K,
  ...ref: [] | [ref: Ref]
) => StackVar<[Result] extends [never] ? FieldOf<F, K> : Result>;
type StructSet = <F extends Fields, K extends keyof F & string>(
  type: StructType<F>,
  field: K,
  ...operands: [] | [ref: Ref, value: Input<FieldOf<F, K>>]
) => void;
type ArrayNew = <E extends FieldInput>(
  type: ArrayType<E>,
  ...operands: [] | [value: Input<ElementOf<E>>, length: Input<"i32">]
) => StackVar<RefType>;
type ArrayNewFixed = <E extends FieldInput>(
  type: ArrayType<E>,
  elements: number | Input<ElementOf<E>>[],
) => StackVar<RefType>;
type ArrayGet<Result = never> = <E extends FieldInput>(
  type: ArrayType<E>,
  ...operands: [] | [ref: Ref, index: Input<"i32">]
) => StackVar<[Result] extends [never] ? ElementOf<E> : Result>;
type ArraySet = <E extends FieldInput>(
  type: ArrayType<E>,
  ...operands: [] | [ref: Ref, index: Input<"i32">, value: Input<ElementOf<E>>]
) => void;
type ArrayFill = <E extends FieldInput>(
  type: ArrayType<E>,
  ...operands:
    [] | [ref: Ref, offset: Input<"i32">, value: Input<ElementOf<E>>, length: Input<"i32">]
) => void;

const StructField = tuple([TypeIndex, U32]);
const resolveType = ([typeIdx]: number[]) => typeIdx;
const resolveTypeAnd = ([typeIdx]: number[], second: number) => [typeIdx, second];

const structNewInstruction = define("struct.new", TypeIndex, resolveType);

/** A struct with the field values on the stack, or given by field name. */
function structNew(ctx: LocalContext, type: DefinedType, fields?: Record<string, Operand>) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "struct.new");
  let types = structFields(type).map((f) => unpacked(f.type));
  let operands: unknown[] = noOperands;
  if (fields !== undefined) {
    let names = type.fieldNames;
    if (names === undefined)
      throw Error("struct.new: fields by name need a struct with field names");
    operands = namedInputs(names, fields);
  }
  takeOperands(ctx, "struct.new", types, operands);
  emitInstruction(ctx, structNewInstruction, [type], []);
  return pushResult(ctx, refType(type, false));
}
const noOperands: unknown[] = [];

/** A field of a struct, by name or index; packed fields need `get_s` or `get_u`. */
function structGet(name: "struct.get" | "struct.get_s" | "struct.get_u") {
  let instruction = define(name, StructField, resolveTypeAnd);
  return typedByImmediates(instruction, 2, (type: DefinedType, field: string | number) => {
    let index = fieldIndex(type, field);
    let { type: storage } = structFields(type)[index];
    let packed = storage === "i8" || storage === "i16";
    if (packed !== (name !== "struct.get"))
      throw Error(
        `${name}: ${packed ? "packed fields need get_s or get_u" : "field is not packed"}`,
      );
    return { in: [nullableRef(type)], out: [unpacked(storage)], deps: [type], args: [index] };
  });
}

const structOps = {
  new: withPublicSignature<StructNew>()(structNew),
  new_default: typedByImmediates(
    define("struct.new_default", TypeIndex, resolveType),
    1,
    (type: DefinedType) => {
      structFields(type);
      return { in: [], out: [refType(type, false)], deps: [type], args: [] };
    },
  ),
  get: withPublicSignature<StructGet>()(structGet("struct.get")),
  get_s: withPublicSignature<StructGet<"i32">>()(structGet("struct.get_s")),
  get_u: withPublicSignature<StructGet<"i32">>()(structGet("struct.get_u")),
  set: withPublicSignature<StructSet>()(
    typedByImmediates(
      define("struct.set", StructField, resolveTypeAnd),
      2,
      (type: DefinedType, field: string | number) => {
        let index = fieldIndex(type, field);
        return {
          in: [nullableRef(type), unpacked(structFields(type)[index].type)],
          out: [],
          deps: [type],
          args: [index],
        };
      },
    ),
  ),
};

/** An element of an array; packed elements need `get_s` or `get_u`. */
function arrayGet(name: "array.get" | "array.get_s" | "array.get_u") {
  return typedByImmediates(define(name, TypeIndex, resolveType), 1, (type: DefinedType) => {
    let { type: storage } = arrayElement(type);
    let packed = storage === "i8" || storage === "i16";
    if (packed !== (name !== "array.get"))
      throw Error(
        `${name}: ${packed ? "packed elements need get_s or get_u" : "element is not packed"}`,
      );
    return { in: [nullableRef(type), "i32"], out: [unpacked(storage)], deps: [type], args: [] };
  });
}

/** Instructions on an array type and a data or element segment. */
function arraySegment(
  name: "array.new_data" | "array.new_elem" | "array.init_data" | "array.init_elem",
) {
  let segment = name.endsWith("data") ? DataIndex : ElemIndex;
  let isNew = name.startsWith("array.new");
  let instruction = define(name, tuple([TypeIndex, segment]), ([typeIdx, segmentIdx]: number[]) => [
    typeIdx,
    segmentIdx,
  ]);
  return typedByImmediates(
    instruction,
    2,
    (type: DefinedType, from: Dependency.Data | Dependency.Elem) => {
      arrayElement(type);
      return {
        in: isNew ? ["i32", "i32"] : [nullableRef(type), "i32", "i32", "i32"],
        out: isNew ? [refType(type, false)] : [],
        deps: [type, from],
        args: [],
      };
    },
  );
}

const arrayNewFixedInstruction = define("array.new_fixed", tuple([TypeIndex, U32]), resolveTypeAnd);

/** An array of the given number of elements on the stack, or of the given elements. */
function arrayNewFixed(ctx: LocalContext, type: DefinedType, elements: number | Operand[]) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "array.new_fixed");
  let length = typeof elements === "number" ? elements : elements.length;
  let element = unpacked(arrayElement(type).type);
  takeOperands(
    ctx,
    "array.new_fixed",
    Array(length).fill(element),
    typeof elements === "number" ? noOperands : elements,
  );
  emitInstruction(ctx, arrayNewFixedInstruction, [type], [length]);
  return pushResult(ctx, refType(type, false));
}

const arrayOps = {
  new: withPublicSignature<ArrayNew>()(
    typedByImmediates(define("array.new", TypeIndex, resolveType), 1, (type: DefinedType) => ({
      in: [unpacked(arrayElement(type).type), "i32"],
      out: [refType(type, false)],
      deps: [type],
      args: [],
    })),
  ),
  new_default: typedByImmediates(
    define("array.new_default", TypeIndex, resolveType),
    1,
    (type: DefinedType) => {
      arrayElement(type);
      return { in: ["i32"], out: [refType(type, false)], deps: [type], args: [] };
    },
  ),
  new_fixed: withPublicSignature<ArrayNewFixed>()(arrayNewFixed),
  new_data: arraySegment("array.new_data"),
  new_elem: arraySegment("array.new_elem"),
  get: withPublicSignature<ArrayGet>()(arrayGet("array.get")),
  get_s: withPublicSignature<ArrayGet<"i32">>()(arrayGet("array.get_s")),
  get_u: withPublicSignature<ArrayGet<"i32">>()(arrayGet("array.get_u")),
  set: withPublicSignature<ArraySet>()(
    typedByImmediates(define("array.set", TypeIndex, resolveType), 1, (type: DefinedType) => ({
      in: [nullableRef(type), "i32", unpacked(arrayElement(type).type)],
      out: [],
      deps: [type],
      args: [],
    })),
  ),
  len: fixed<[RefType], ["i32"]>("array.len", [arrayref], [i32t]),
  fill: withPublicSignature<ArrayFill>()(
    typedByImmediates(define("array.fill", TypeIndex, resolveType), 1, (type: DefinedType) => ({
      in: [nullableRef(type), "i32", unpacked(arrayElement(type).type), "i32"],
      out: [],
      deps: [type],
      args: [],
    })),
  ),
  copy: typedByImmediates(
    define("array.copy", tuple([TypeIndex, TypeIndex]), ([destination, source]: number[]) => [
      destination,
      source,
    ]),
    2,
    (destination: DefinedType, source: DefinedType) => {
      arrayElement(destination);
      arrayElement(source);
      return {
        in: [nullableRef(destination), "i32", nullableRef(source), "i32", "i32"],
        out: [],
        deps: [destination, source],
        args: [],
      };
    },
  ),
  init_data: arraySegment("array.init_data"),
  init_elem: arraySegment("array.init_elem"),
};

const i31Ops = {
  get_s: fixed<[RefType], ["i32"]>("i31.get_s", [i31ref], [i32t]),
  get_u: fixed<[RefType], ["i32"]>("i31.get_u", [i31ref], [i32t]),
};

/** The top of a heap type's hierarchy, which tests and casts take as operand. */
function top(type: RefType): AbstractHeapType {
  let { ref } = referenced(type);
  return (["any", "func", "extern"] as const).find((top) => isHeapSubtype(ref, top)) ?? "exn";
}

function heapDeps(type: RefType): Dependency.t[] {
  let heap = referenced(type).ref;
  return typeof heap === "object" ? [heap] : [];
}

/** Test or cast to a reference type; nullable types test and cast null successfully. */
function testOrCast(kind: "test" | "cast") {
  let [nonNull, nullable] = [`ref.${kind}`, `ref.${kind}_null`].map((name) =>
    define(name as "ref.test", HeapType),
  );
  let name = `ref.${kind}`;
  let testOrCast = (ctx: LocalContext, type: Type<RefType>, operand?: Operand) => {
    if (ctx.allowed !== undefined) checkAllowed(ctx, name);
    let literal = valueTypeLiteral(type);
    let { ref, nullable: isNullable } = referenced(literal);
    takeOne(ctx, name, refType(top(literal), true), operand);
    emitInstruction(ctx, isNullable ? nullable : nonNull, heapDeps(literal), [ref]);
    return pushResult(ctx, kind === "test" ? "i32" : literal);
  };
  return Object.assign(testOrCast, { instructions: [nonNull, nullable] });
}

const gcRefOps = {
  i31: fixed<["i32"], [RefType]>("ref.i31", [i32t], [{ kind: refType("i31", false) }]),
  eq: fixed<[RefType, RefType], ["i32"]>("ref.eq", [eqref, eqref], [i32t]),
  test: withPublicSignature<(type: Type<RefType>, ...operand: [] | [Operand]) => StackVar<"i32">>()(
    testOrCast("test"),
  ),
  cast: withPublicSignature<
    <T extends RefType>(type: Type<T>, ...operand: [] | [Operand]) => StackVar<T>
  >()(testOrCast("cast")),
};

/** The type of an operand, or of the value on the stack. */
function operandType(ctx: LocalContext, operand: Operand | undefined): ValueType | Unknown {
  if (operand === undefined || isStackVar(operand)) {
    let type = (operand ?? ctx.stack.at(-1))?.type;
    return type ?? Unknown;
  }
  if (typeof operand === "object" && operand !== null && "kind" in operand) {
    if (operand.kind === "local") return ctx.locals[operand.index] ?? Unknown;
    if (operand.kind === "global" || operand.kind === "importGlobal") return operand.type.value;
  }
  return Unknown;
}

/** Conversion between internal and external references, which keeps nullability. */
function convert(name: "any.convert_extern" | "extern.convert_any", from: "extern" | "any") {
  let instruction = define(name);
  let to: AbstractHeapType = from === "extern" ? "any" : "extern";
  let convert = (ctx: LocalContext, operand?: Operand) => {
    if (ctx.allowed !== undefined) checkAllowed(ctx, name);
    let type = operandType(ctx, operand);
    let nullable = type === Unknown || !isRefType(type) || referenced(type).nullable;
    takeOne(ctx, name, refType(from, true), operand);
    writeOpcode(ctx.code, instruction.opcodeBytes);
    return pushResult(ctx, refType(to, nullable));
  };
  return Object.assign(convert, { instruction });
}

const anyOps = { convert_extern: convert("any.convert_extern", "extern") };
const externOps = { convert_any: convert("extern.convert_any", "any") };

/** The type of `from` without `to`: non-null if `to` catches null. */
function difference(from: RefType, to: RefType): RefType {
  let { ref, nullable } = referenced(from);
  return refType(ref, nullable && !referenced(to).nullable);
}

/** br_on_cast's flags: bit 0 if the operand type is nullable, bit 1 if the target type is. */
type BrOnCast = { label: number; from: RefType; to: RefType };
const BrOnCast = Binable<BrOnCast>({
  writeBytes(output, { label, from, to }) {
    writeByte(output, (referenced(from).nullable ? 1 : 0) | (referenced(to).nullable ? 2 : 0));
    U32.writeBytes(output, label);
    HeapType.writeBytes(output, referenced(from).ref);
    HeapType.writeBytes(output, referenced(to).ref);
  },
  readBytes(input) {
    let flags = input.bytes[input.offset++];
    if (flags === undefined || flags > 3) throw Error("malformed cast flags");
    let label = U32.readBytes(input);
    let from = HeapType.readBytes(input);
    let to = HeapType.readBytes(input);
    return { label, from: refType(from, (flags & 1) !== 0), to: refType(to, (flags & 2) !== 0) };
  },
});

/**
 * Branch with the reference if it is of type `to`; otherwise continue with it. br_on_cast_fail
 * branches in the opposite case.
 */
function branchOnCast(name: "br_on_cast" | "br_on_cast_fail") {
  let instruction = define(name, BrOnCast);
  let branch = (
    ctx: LocalContext,
    label: Label | number,
    fromType: Type<RefType>,
    toType: Type<RefType>,
  ) => {
    let [from, to] = [valueTypeLiteral(fromType), valueTypeLiteral(toType)];
    if (!isSubtype(to, from))
      throw Error(`${name}: ${printValueType(to)} is not a subtype of ${printValueType(from)}`);
    let [depth, frame] = getFrameFromLabel(ctx, label);
    let types = labelTypes(frame);
    let [branch, rest] =
      name === "br_on_cast" ? [to, difference(from, to)] : [difference(from, to), to];
    let target = types.at(-1);
    if (target === undefined || !isSubtype(branch, target))
      throw Error(`${name}: the label's last type must fit ${printValueType(branch)}`);
    popStack(ctx, [from]);
    checkStack(ctx, types.slice(0, -1));
    pushStack(ctx, [rest]);
    emitInstruction(
      ctx,
      instruction,
      [...heapDeps(from), ...heapDeps(to)],
      [{ label: depth, from, to }],
    );
  };
  return Object.assign(branch, { instruction });
}
const br_on_cast = branchOnCast("br_on_cast");
const br_on_cast_fail = branchOnCast("br_on_cast_fail");

/** Instructions that the operations above write themselves, which lookups by name or opcode find. */
const instructions = [structNewInstruction, arrayNewFixedInstruction];
