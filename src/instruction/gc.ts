import { Binable, tuple, Undefined } from "../binable.ts";
import type * as Dependency from "../dependency.ts";
import { U32 } from "../immediate.ts";
import {
  getFrameFromLabel,
  type Label,
  labelTypes,
  type LocalContext,
  popStack,
  pushStack,
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
} from "../types.ts";
import { baseInstruction } from "./base.ts";

export { structOps, arrayOps, i31Ops, gcRefOps, anyOps, externOps, br_on_cast, br_on_cast_fail };

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

const StructField = tuple([TypeIndex, U32]);

function structGet(name: "struct.get" | "struct.get_s" | "struct.get_u") {
  return baseInstruction(name, StructField, {
    create(_, type: DefinedType, field: string | number) {
      let index = fieldIndex(type, field);
      let { type: storage } = structFields(type)[index];
      let packed = storage === "i8" || storage === "i16";
      if (packed !== (name !== "struct.get"))
        throw Error(
          `${name}: ${packed ? "packed fields need get_s or get_u" : "field is not packed"}`,
        );
      return {
        in: [nullableRef(type)],
        out: [unpacked(storage)],
        deps: [type],
        resolveArgs: [index],
      };
    },
    resolve: ([typeIdx], field: number) => [typeIdx, field],
  });
}

const structOps = {
  /** A struct with the field values on the stack. */
  new: baseInstruction("struct.new", TypeIndex, {
    create(_, type: DefinedType) {
      return {
        in: structFields(type).map((f) => unpacked(f.type)),
        out: [refType(type, false)],
        deps: [type],
      };
    },
    resolve: ([typeIdx]) => typeIdx,
  }),
  new_default: baseInstruction("struct.new_default", TypeIndex, {
    create(_, type: DefinedType) {
      structFields(type);
      return { in: [], out: [refType(type, false)], deps: [type] };
    },
    resolve: ([typeIdx]) => typeIdx,
  }),
  get: structGet("struct.get"),
  get_s: structGet("struct.get_s"),
  get_u: structGet("struct.get_u"),
  set: baseInstruction("struct.set", StructField, {
    create(_, type: DefinedType, field: string | number) {
      let index = fieldIndex(type, field);
      return {
        in: [nullableRef(type), unpacked(structFields(type)[index].type)],
        out: [],
        deps: [type],
        resolveArgs: [index],
      };
    },
    resolve: ([typeIdx], field: number) => [typeIdx, field],
  }),
};

function arrayGet(name: "array.get" | "array.get_s" | "array.get_u") {
  return baseInstruction(name, TypeIndex, {
    create(_, type: DefinedType) {
      let { type: storage } = arrayElement(type);
      let packed = storage === "i8" || storage === "i16";
      if (packed !== (name !== "array.get"))
        throw Error(
          `${name}: ${packed ? "packed elements need get_s or get_u" : "element is not packed"}`,
        );
      return { in: [nullableRef(type), "i32"], out: [unpacked(storage)], deps: [type] };
    },
    resolve: ([typeIdx]) => typeIdx,
  });
}

/** Instructions on an array type and a data or element segment. */
function arraySegment(
  name: "array.new_data" | "array.new_elem" | "array.init_data" | "array.init_elem",
) {
  let segment = name.endsWith("data") ? DataIndex : ElemIndex;
  return baseInstruction(name, tuple([TypeIndex, segment]), {
    create(_, type: DefinedType, from: Dependency.Data | Dependency.Elem) {
      arrayElement(type);
      let isNew = name.startsWith("array.new");
      return {
        in: isNew ? ["i32", "i32"] : [nullableRef(type), "i32", "i32", "i32"],
        out: isNew ? [refType(type, false)] : [],
        deps: [type, from],
      };
    },
    resolve: ([typeIdx, segmentIdx]) => [typeIdx, segmentIdx],
  });
}

const arrayOps = {
  /** An array of a length, filled with a value. */
  new: baseInstruction("array.new", TypeIndex, {
    create(_, type: DefinedType) {
      return {
        in: [unpacked(arrayElement(type).type), "i32"],
        out: [refType(type, false)],
        deps: [type],
      };
    },
    resolve: ([typeIdx]) => typeIdx,
  }),
  new_default: baseInstruction("array.new_default", TypeIndex, {
    create(_, type: DefinedType) {
      arrayElement(type);
      return { in: ["i32"], out: [refType(type, false)], deps: [type] };
    },
    resolve: ([typeIdx]) => typeIdx,
  }),
  /** An array of the given number of elements on the stack. */
  new_fixed: baseInstruction("array.new_fixed", tuple([TypeIndex, U32]), {
    create(_, type: DefinedType, length: number) {
      let element = unpacked(arrayElement(type).type);
      return {
        in: Array(length).fill(element),
        out: [refType(type, false)],
        deps: [type],
        resolveArgs: [length],
      };
    },
    resolve: ([typeIdx], length: number) => [typeIdx, length],
  }),
  new_data: arraySegment("array.new_data"),
  new_elem: arraySegment("array.new_elem"),
  get: arrayGet("array.get"),
  get_s: arrayGet("array.get_s"),
  get_u: arrayGet("array.get_u"),
  set: baseInstruction("array.set", TypeIndex, {
    create(_, type: DefinedType) {
      return {
        in: [nullableRef(type), "i32", unpacked(arrayElement(type).type)],
        out: [],
        deps: [type],
      };
    },
    resolve: ([typeIdx]) => typeIdx,
  }),
  len: baseInstruction("array.len", Undefined, {
    create() {
      return { in: ["arrayref"], out: ["i32"] };
    },
    resolve: () => undefined,
  }),
  fill: baseInstruction("array.fill", TypeIndex, {
    create(_, type: DefinedType) {
      return {
        in: [nullableRef(type), "i32", unpacked(arrayElement(type).type), "i32"],
        out: [],
        deps: [type],
      };
    },
    resolve: ([typeIdx]) => typeIdx,
  }),
  copy: baseInstruction("array.copy", tuple([TypeIndex, TypeIndex]), {
    create(_, destination: DefinedType, source: DefinedType) {
      arrayElement(destination);
      arrayElement(source);
      return {
        in: [nullableRef(destination), "i32", nullableRef(source), "i32", "i32"],
        out: [],
        deps: [destination, source],
      };
    },
    resolve: ([destination, source]) => [destination, source],
  }),
  init_data: arraySegment("array.init_data"),
  init_elem: arraySegment("array.init_elem"),
};

const i31Ops = {
  get_s: baseInstruction("i31.get_s", Undefined, {
    create: () => ({ in: ["i31ref"], out: ["i32"] }),
    resolve: () => undefined,
  }),
  get_u: baseInstruction("i31.get_u", Undefined, {
    create: () => ({ in: ["i31ref"], out: ["i32"] }),
    resolve: () => undefined,
  }),
};

/** The top of a heap type's hierarchy, which tests and casts take as operand. */
function top(type: RefType): AbstractHeapType {
  let { ref } = referenced(type);
  return (["any", "func", "extern"] as const).find((top) => isHeapSubtype(ref, top)) ?? "exn";
}

/** Test or cast to a reference type; nullable types test and cast null successfully. */
function testOrCast(kind: "test" | "cast") {
  let instructions = [`ref.${kind}`, `ref.${kind}_null`].map((name) =>
    baseInstruction(name as "ref.test", HeapType, {
      create(_, type: RefType) {
        return {
          in: [refType(top(type), true)],
          out: [kind === "test" ? "i32" : type],
          deps: heapDeps(type),
          resolveArgs: [referenced(type).ref],
        };
      },
    }),
  );
  return (ctx: LocalContext, type: Type<RefType>) => {
    let literal = valueTypeLiteral(type);
    return instructions[referenced(literal).nullable ? 1 : 0](ctx, literal);
  };
}

function heapDeps(type: RefType): Dependency.t[] {
  let heap = referenced(type).ref;
  return typeof heap === "object" ? [heap] : [];
}

const gcRefOps = {
  /** A 31-bit integer as an i31 reference. */
  i31: baseInstruction("ref.i31", Undefined, {
    create: () => ({ in: ["i32"], out: [refType("i31", false)] }),
    resolve: () => undefined,
  }),
  /** Whether two references are the same object. */
  eq: baseInstruction("ref.eq", Undefined, {
    create: () => ({ in: ["eqref", "eqref"], out: ["i32"] }),
    resolve: () => undefined,
  }),
  test: testOrCast("test"),
  cast: testOrCast("cast"),
};

/** Conversion between internal and external references, which keeps nullability. */
function convert(name: "any.convert_extern" | "extern.convert_any", from: "extern" | "any") {
  return baseInstruction(name, Undefined, {
    create({ stack }: LocalContext) {
      let type = stack.at(-1)?.type ?? Unknown;
      let nullable = type === Unknown || !isRefType(type) || referenced(type).nullable;
      let to: AbstractHeapType = from === "extern" ? "any" : "extern";
      return { in: [refType(from, true)], out: [refType(to, nullable)] };
    },
    resolve: () => undefined,
  });
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
  toBytes({ label, from, to }) {
    let flags = (referenced(from).nullable ? 1 : 0) | (referenced(to).nullable ? 2 : 0);
    let heaps = [
      ...HeapType.toBytes(referenced(from).ref),
      ...HeapType.toBytes(referenced(to).ref),
    ];
    return [flags, ...U32.toBytes(label), ...heaps];
  },
  readBytes(bytes, offset) {
    let flags = bytes[offset++];
    if (flags === undefined || flags > 3) throw Error("malformed cast flags");
    let label: number, from: HeapType, to: HeapType;
    [label, offset] = U32.readBytes(bytes, offset);
    [from, offset] = HeapType.readBytes(bytes, offset);
    [to, offset] = HeapType.readBytes(bytes, offset);
    return [
      { label, from: refType(from, (flags & 1) !== 0), to: refType(to, (flags & 2) !== 0) },
      offset,
    ];
  },
});

/**
 * Branch with the reference if it is of type `to`; otherwise continue with it. br_on_cast_fail
 * branches in the opposite case.
 */
function branchOnCast(name: "br_on_cast" | "br_on_cast_fail") {
  return baseInstruction(name, BrOnCast, {
    create(ctx, label: Label | number, fromType: Type<RefType>, toType: Type<RefType>) {
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
      pushStack(ctx, popStack(ctx, types.slice(0, -1)));
      pushStack(ctx, [rest]);
      return {
        in: [],
        out: [],
        deps: [...heapDeps(from), ...heapDeps(to)],
        resolveArgs: [{ label: depth, from, to }],
      };
    },
  });
}

const br_on_cast = branchOnCast("br_on_cast");
const br_on_cast_fail = branchOnCast("br_on_cast_fail");
