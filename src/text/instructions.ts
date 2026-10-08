import { Byte, Undefined } from "../binable.ts";
import { F32, F64, I32, I64, U8, type U64 } from "../immediate.ts";
import type { ResolvedInstruction } from "../instruction/base.ts";
import { lookupInstruction } from "../instruction/all.ts";
import { Block, type Catch, IfBlock, TryTable } from "../instruction/binable.ts";
import {
  type AbstractHeapType,
  HeapType,
  isRefType,
  referenced,
  refType,
  shorthands,
  type IndexSpace,
  type StorageType,
  type ValueType,
} from "../types.ts";
import { Cursor } from "./cursor.ts";
import { TextSyntaxError, UnsupportedTextError } from "./lexer.ts";
import {
  parseFloat,
  parseInteger,
  parseU32,
  parseU64,
  parseUnsigned,
  printFloat,
} from "./numbers.ts";

export {
  parseInstructions,
  printInstructions,
  parseValueType,
  printValueType,
  printHeapType,
  printString,
};
export type { Scope, Names, BlockType };

type BlockType = "empty" | ValueType | number;

/** What instruction parsing needs from its module and function: name resolution and type uses. */
type Scope = {
  /** Read an index of a module space or of locals, resolving identifiers. */
  index(c: Cursor, space: Exclude<IndexSpace, "label">): number;
  /** Read `(type x)? (param ...)* (result ...)*` and return its type index. */
  typeUse(c: Cursor): number;
  /** Read a block type: a type use, abbreviated to a value type or nothing where possible. */
  blockType(c: Cursor): BlockType;
  /** Enclosing block labels, innermost first. */
  labels: (string | undefined)[];
  /** Read a field index of a struct type, resolving field identifiers. */
  field(c: Cursor, type: number): number;
};

/** What printing needs: identifiers by index space and of struct fields, if an index has one. */
type Names = {
  id(space: IndexSpace, index: number): string | undefined;
  field(type: number, field: number): string | undefined;
  /** A type use: inline parameters and results, preceded by the type unless they imply it. */
  typeUse(type: number, block?: boolean): string;
};

const blocks = new Set(["block", "loop", "if", "try_table"]);
const catchKinds = new Set(["catch", "catch_ref", "catch_all", "catch_all_ref"]);
const valueTypes = new Set<string>([
  "i32",
  "i64",
  "f32",
  "f64",
  "v128",
  ...Object.keys(shorthands),
]);
const abstractHeapTypes = new Set<string>(Object.values(shorthands));
// Valid instructions of features that wasmati's module representation does not support yet.
const unsupported = /^rethrow$/;

/** Resolves a type index or identifier, for references to defined types. */
type TypeIndex = (c: Cursor) => number;

/** A value type: a number or vector type, `funcref`/`externref`, or `(ref null? heaptype)`. */
function parseValueType(c: Cursor, typeIndex: TypeIndex): ValueType {
  const reference = c.maybeList("ref");
  if (reference !== undefined) {
    const nullable = reference.maybeKeyword("null");
    const heap = parseHeapType(reference, typeIndex);
    reference.end();
    return refType(heap, nullable);
  }
  const node = c.peek();
  const type = c.atom();
  if (valueTypes.has(type)) return type as ValueType;
  return c.fail(`unknown value type ${type}`, node);
}

function parseHeapType(c: Cursor, typeIndex: TypeIndex): HeapType {
  if (c.peekIndex()) return typeIndex(c);
  const node = c.peek();
  const heap = c.atom();
  if (abstractHeapTypes.has(heap)) return heap as AbstractHeapType;
  return c.fail(`unknown heap type ${heap}`, node);
}

function printHeapType(heap: HeapType, names: Names): string {
  if (typeof heap === "object") throw Error("printHeapType: function type has no index");
  return typeof heap === "number" ? (names.id("type", heap) ?? String(heap)) : heap;
}

function printValueType(type: StorageType, names: Names): string {
  if (typeof type !== "object") return type;
  return `(ref ${type.nullable ? "null " : ""}${printHeapType(type.ref, names)})`;
}

/** Read instructions, flat or folded, until the list ends or a block delimiter follows. */
function parseInstructions(c: Cursor, scope: Scope): ResolvedInstruction[] {
  const body: ResolvedInstruction[] = [];
  while (!c.done && c.peekAtom() !== "end" && c.peekAtom() !== "else") instruction(c, scope, body);
  return body;
}

const branchHint = "@metadata.code.branch_hint";

function instruction(c: Cursor, scope: Scope, body: ResolvedInstruction[]) {
  if (c.peekHead() === branchHint) {
    // A hint belongs to the next instruction, which comes last in its folded form.
    const likely = parseBranchHint(c.list(branchHint));
    if (c.done || c.peekAtom() === "end" || c.peekAtom() === "else" || c.peekHead() === branchHint)
      c.fail(`${branchHint} annotation: expected an instruction`);
    instruction(c, scope, body);
    body[body.length - 1].likely = likely;
    return;
  }
  if (c.peek()?.kind === "list") {
    const list = c.list();
    folded(list, scope, body);
    list.end();
    return;
  }
  const name = c.atom();
  if (!blocks.has(name)) {
    body.push(plain(name, c, scope));
    return;
  }
  const label = c.identifier();
  const blockType = scope.blockType(c);
  const catches = parseCatches(c, scope);
  const nested = { ...scope, labels: [label, ...scope.labels] };
  const instructions = parseInstructions(c, nested);
  let otherwise: ResolvedInstruction[] | undefined;
  if (name === "if" && c.maybeKeyword("else")) {
    endLabel(c, label);
    otherwise = parseInstructions(c, nested);
  }
  c.keyword("end");
  endLabel(c, label);
  body.push(block(name, blockType, instructions, otherwise, catches));
}

/** `(@metadata.code.branch_hint "\00")` for an unlikely branch, `"\01"` for a likely one. */
function parseBranchHint(c: Cursor): boolean {
  const node = c.peek();
  const bytes = c.peek()?.kind === "string" ? c.bytes() : [];
  if (bytes.length !== 1 || bytes[0] > 1) c.fail(`${branchHint} annotation: malformed hint`, node);
  c.end();
  return bytes[0] === 1;
}

/** The catch clauses of try_table, whose labels are outside the block. */
function parseCatches(c: Cursor, scope: Scope): Catch[] {
  const catches: Catch[] = [];
  while (catchKinds.has(c.peekHead() ?? "")) {
    const kind = c.peekHead() as Catch["kind"];
    const clause = c.list(kind);
    if (kind === "catch" || kind === "catch_ref") {
      const tag = scope.index(clause, "tag");
      catches.push({ kind, tag, label: label(clause, scope) });
    } else catches.push({ kind, label: label(clause, scope) });
    clause.end();
  }
  return catches;
}

/** A folded instruction runs its operands, left to right, before itself. */
function folded(c: Cursor, scope: Scope, body: ResolvedInstruction[]) {
  const name = c.atom();
  if (!blocks.has(name)) {
    const instruction = plain(name, c, scope);
    while (!c.done) {
      const operand = c.list();
      folded(operand, scope, body);
      operand.end();
    }
    body.push(instruction);
    return;
  }
  const label = c.identifier();
  const blockType = scope.blockType(c);
  const catches = parseCatches(c, scope);
  const nested = { ...scope, labels: [label, ...scope.labels] };
  if (name !== "if") {
    body.push(block(name, blockType, parseInstructions(c, nested), undefined, catches));
    return;
  }
  // The condition is outside the block, so it cannot branch to the if's label.
  while (c.peekHead() !== "then") {
    const operand = c.list();
    folded(operand, scope, body);
    operand.end();
  }
  const then = c.list("then");
  const instructions = parseInstructions(then, nested);
  then.end();
  const otherwise = c.maybeList("else");
  const elseBody = otherwise && parseInstructions(otherwise, nested);
  otherwise?.end();
  body.push(block(name, blockType, instructions, elseBody, catches));
}

function endLabel(c: Cursor, label: string | undefined) {
  const node = c.peek();
  const end = c.identifier();
  if (end !== undefined && end !== label) c.fail("mismatching label", node);
}

function block(
  name: string,
  blockType: BlockType,
  instructions: ResolvedInstruction[],
  otherwise: ResolvedInstruction[] | undefined,
  catches: Catch[],
): ResolvedInstruction {
  if (name === "if")
    return { name, immediate: { blockType, instructions: { if: instructions, else: otherwise } } };
  if (name === "try_table") return { name, immediate: { blockType, catches, instructions } };
  if (catches.length > 0) throw new TextSyntaxError(`${name} has no catch clauses`);
  return { name, immediate: { blockType, instructions } };
}

function definition(name: string, c: Cursor) {
  try {
    return lookupInstruction(name === "select" && c.peekHead() === "result" ? "select_t" : name);
  } catch {
    if (unsupported.test(name))
      throw new UnsupportedTextError(`instruction ${name} is not supported`);
    return c.fail(`unknown operator ${name}`);
  }
}

/**
 * An instruction without a body. `select` with result types is the typed `select_t`, and tests and
 * casts to nullable types are the `_null` variants.
 */
function plain(name: string, c: Cursor, scope: Scope): ResolvedInstruction {
  if (name === "ref.test" || name === "ref.cast") {
    const { ref, nullable } = referenced(refTypeOf(c, scope));
    return { name: nullable ? `${name}_null` : name, immediate: ref };
  }
  const instruction = definition(name, c);
  return { name: instruction.string, immediate: immediate(instruction, c, scope) };
}

/** Immediates follow from the instruction's binary immediate, which records index spaces and alignment. */
function immediate(
  { string, immediate }: ReturnType<typeof lookupInstruction>,
  c: Cursor,
  scope: Scope,
): unknown {
  if (immediate === undefined || immediate === Undefined) return undefined;
  if ("space" in immediate) {
    const space = immediate.space as IndexSpace;
    // Table and memory indices default to 0.
    if ((space === "table" || space === "memory") && !c.peekIndex()) return 0;
    return space === "label" ? label(c, scope) : scope.index(c, space);
  }
  if ("naturalAlign" in immediate) {
    const natural = immediate.naturalAlign as number;
    if (string.endsWith("_lane")) {
      // A leading index followed by another index or memarg is a memory index.
      const named =
        c.peekIndex() && (c.peekIndex(1) || /^(offset|align)=/.test(c.peekAtom(1) ?? ""));
      const memory = named ? scope.index(c, "memory") : 0;
      return { memArg: memArg(c, natural, memory), lane: lane(c) };
    }
    const memory = c.peekIndex() ? scope.index(c, "memory") : 0;
    return memArg(c, natural, memory);
  }
  switch (immediate) {
    case I32:
      return Number(c.parse((text) => parseInteger(text, 32)));
    case I64:
      return c.parse((text) => parseInteger(text, 64));
    case F32:
      return c.parse((text) => parseFloat(text, 32));
    case F64:
      return c.parse((text) => parseFloat(text, 64));
    case U8:
      return lane(c);
    case Byte:
      return 0;
    case HeapType:
      return parseHeapType(c, (c) => scope.index(c, "type"));
    case Block:
    case IfBlock:
    case TryTable:
      throw Error("unreachable");
  }
  switch (string) {
    case "br_table": {
      const indices: number[] = [];
      do indices.push(label(c, scope));
      while (c.peekIndex());
      return { indices: indices.slice(0, -1), defaultIndex: indices.at(-1)! };
    }
    case "call_indirect":
    case "return_call_indirect": {
      const table = c.peekIndex() ? scope.index(c, "table") : 0;
      return [scope.typeUse(c), table];
    }
    case "select_t":
      return c
        .lists("result", (result) =>
          result.until((c) => parseValueType(c, (c) => scope.index(c, "type"))),
        )
        .flat();
    case "memory.init":
    case "table.init": {
      // An optional memory or table index precedes the segment index.
      const [segment, target] =
        string === "memory.init" ? (["data", "memory"] as const) : (["elem", "table"] as const);
      const index = c.peekIndex(1) ? scope.index(c, target) : 0;
      return [scope.index(c, segment), index];
    }
    case "memory.copy":
    case "table.copy": {
      const space = string === "memory.copy" ? "memory" : "table";
      if (!c.peekIndex()) return [0, 0];
      return [scope.index(c, space), scope.index(c, space)];
    }
    case "v128.const":
      return v128(c);
    case "i8x16.shuffle":
      return Array.from({ length: 16 }, () => lane(c));
    case "struct.get":
    case "struct.get_s":
    case "struct.get_u":
    case "struct.set": {
      const type = scope.index(c, "type");
      return [type, scope.field(c, type)];
    }
    case "array.new_fixed":
      return [scope.index(c, "type"), c.parse(parseU32)];
    case "array.new_data":
    case "array.init_data":
      return [scope.index(c, "type"), scope.index(c, "data")];
    case "array.new_elem":
    case "array.init_elem":
      return [scope.index(c, "type"), scope.index(c, "elem")];
    case "array.copy":
      return [scope.index(c, "type"), scope.index(c, "type")];
    case "br_on_cast":
    case "br_on_cast_fail":
      return { label: label(c, scope), from: refTypeOf(c, scope), to: refTypeOf(c, scope) };
  }
  throw new UnsupportedTextError(`text immediate of ${string} is not implemented`);
}

function refTypeOf(c: Cursor, scope: Scope) {
  const node = c.peek();
  const type = parseValueType(c, (c) => scope.index(c, "type"));
  if (!isRefType(type)) c.fail("expected a reference type", node);
  return type;
}

/** Labels are relative: a label's index is the number of blocks between it and the branch. */
function label(c: Cursor, scope: Scope): number {
  const node = c.peek();
  const index = c.index();
  if (typeof index === "number") return index;
  const depth = scope.labels.indexOf(index);
  if (depth === -1) c.fail(`unknown label $${index}`, node);
  return depth;
}

/** `offset=`, then `align=`; the memory, if not memory 0, is recorded as in decoded modules. */
function memArg(c: Cursor, natural: number, memory: number) {
  let offset: U64 = 0;
  let align = natural;
  if (c.peekAtom()?.startsWith("offset=")) offset = c.parse((text) => parseU64(text.slice(7)));
  if (c.peekAtom()?.startsWith("align=")) {
    align = c.parse((text) => {
      const bytes = parseUnsigned(text.slice(6), 64);
      if (bytes === 0n || (bytes & (bytes - 1n)) !== 0n)
        throw new TextSyntaxError("alignment must be a power of two");
      return bytes.toString(2).length - 1;
    });
  }
  return memory === 0 ? { offset, align } : { offset, align, memory };
}

function lane(c: Cursor): number {
  return c.parse((text) => {
    const value = parseU32(text);
    if (value > 255) throw new TextSyntaxError("malformed lane index");
    return value;
  });
}

const shapes: Record<string, { float: boolean; width: number }> = {
  i8x16: { float: false, width: 8 },
  i16x8: { float: false, width: 16 },
  i32x4: { float: false, width: 32 },
  i64x2: { float: false, width: 64 },
  f32x4: { float: true, width: 32 },
  f64x2: { float: true, width: 64 },
};

/** A vector constant as 16 little-endian bytes. */
function v128(c: Cursor): number[] {
  const shape = shapes[c.atom()];
  if (shape === undefined) c.fail("unknown vector shape");
  const { float, width } = shape;
  return Array.from({ length: 128 / width }, () => {
    if (float) {
      const value = c.parse((text) => parseFloat(text, width as 32 | 64));
      return [...(width === 32 ? F32.toBytes(value as F32) : F64.toBytes(value as F64))];
    }
    const value = BigInt.asUintN(
      width,
      c.parse((text) => parseInteger(text, width)),
    );
    return Array.from({ length: width / 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));
  }).flat();
}

/** Print stack-style instructions, one per line, indenting block bodies. */
function printInstructions(body: ResolvedInstruction[], names: Names, indent = ""): string[] {
  return body.flatMap(({ name, immediate, likely }) => {
    const hint = likely === undefined ? "" : `(${branchHint} "\\0${likely ? 1 : 0}") `;
    if (blocks.has(name)) {
      const clauses: string[] = (immediate.catches ?? []).map((clause: Catch) => {
        const tag = "tag" in clause ? [names.id("tag", clause.tag) ?? String(clause.tag)] : [];
        return `(${[clause.kind, ...tag, String(clause.label)].join(" ")})`;
      });
      const head = hint + [name, ...blockType(immediate.blockType, names), ...clauses].join(" ");
      const bodies = name === "if" ? immediate.instructions : { if: immediate.instructions };
      return [
        indent + head,
        ...printInstructions(bodies.if, names, indent + "  "),
        ...(bodies.else === undefined
          ? []
          : [indent + "else", ...printInstructions(bodies.else, names, indent + "  ")]),
        indent + "end",
      ];
    }
    const text = name === "select_t" ? "select" : name.replace(/^(ref\.(test|cast))_null$/, "$1");
    return [indent + hint + [text, ...printImmediate(name, immediate, names)].join(" ")];
  });
}

function blockType(type: BlockType, names: Names): string[] {
  if (type === "empty") return [];
  return typeof type === "number"
    ? [names.typeUse(type, true)]
    : [`(result ${printValueType(type, names)})`];
}

function printImmediate(name: string, value: any, names: Names): string[] {
  if (/^ref\.(test|cast)/.test(name))
    return [printValueType(refType(value, name.endsWith("_null")), names)];
  const { immediate } = lookupInstruction(name);
  if (immediate === undefined || immediate === Undefined || immediate === Byte) return [];
  const id = (space: IndexSpace, index: number) => names.id(space, index) ?? String(index);
  if ("space" in immediate) {
    const space = immediate.space as IndexSpace;
    if ((space === "table" || space === "memory") && value === 0) return [];
    return [id(space, value)];
  }
  if ("naturalAlign" in immediate) {
    const natural = immediate.naturalAlign as number;
    if (name.endsWith("_lane"))
      return [...memArgText(value.memArg, natural, id), String(value.lane)];
    return memArgText(value, natural, id);
  }
  switch (immediate) {
    case I32:
    case I64:
    case U8:
      return [String(value)];
    case F32:
      return [printFloat(value, 32)];
    case F64:
      return [printFloat(value, 64)];
    case HeapType:
      return [printHeapType(value, names)];
  }
  switch (name) {
    case "br_table":
      return [...value.indices, value.defaultIndex].map(String);
    case "call_indirect":
    case "return_call_indirect":
      return [...(value[1] === 0 ? [] : [id("table", value[1])]), names.typeUse(value[0])].filter(
        (part) => part !== "",
      );
    case "select_t":
      return [`(result ${value.map((type: ValueType) => printValueType(type, names)).join(" ")})`];
    case "memory.init":
    case "table.init": {
      const [space, target] =
        name === "memory.init" ? (["data", "memory"] as const) : (["elem", "table"] as const);
      return [...(value[1] === 0 ? [] : [id(target, value[1])]), id(space, value[0])];
    }
    case "memory.copy":
    case "table.copy": {
      const space = name === "memory.copy" ? "memory" : "table";
      return value[0] === 0 && value[1] === 0 ? [] : [id(space, value[0]), id(space, value[1])];
    }
    case "v128.const": {
      const lanes = Array.from({ length: 4 }, (_, i) =>
        value
          .slice(4 * i, 4 * i + 4)
          .reduceRight((word: number, byte: number) => word * 256 + byte, 0),
      );
      return ["i32x4", ...lanes.map((lane) => "0x" + lane.toString(16).padStart(8, "0"))];
    }
    case "i8x16.shuffle":
      return value.map(String);
    case "struct.get":
    case "struct.get_s":
    case "struct.get_u":
    case "struct.set":
      return [id("type", value[0]), names.field(value[0], value[1]) ?? String(value[1])];
    case "array.new_fixed":
      return [id("type", value[0]), String(value[1])];
    case "array.new_data":
    case "array.init_data":
      return [id("type", value[0]), id("data", value[1])];
    case "array.new_elem":
    case "array.init_elem":
      return [id("type", value[0]), id("elem", value[1])];
    case "array.copy":
      return [id("type", value[0]), id("type", value[1])];
    case "br_on_cast":
    case "br_on_cast_fail":
      return [
        String(value.label),
        printValueType(value.from, names),
        printValueType(value.to, names),
      ];
  }
  throw new UnsupportedTextError(`text immediate of ${name} is not implemented`);
}

function memArgText(
  { offset, align, memory = 0 }: { offset: U64; align: number; memory?: number },
  natural: number,
  id: (space: IndexSpace, index: number) => string,
) {
  return [
    ...(memory === 0 ? [] : [id("memory", memory)]),
    ...(offset === 0 ? [] : [`offset=${offset}`]),
    ...(align === natural ? [] : [`align=${2n ** BigInt(align)}`]),
  ];
}

/** A string literal; printable ASCII stays readable and other bytes are escaped. */
function printString(bytes: number[] | Uint8Array): string {
  let text = '"';
  for (const byte of bytes) {
    text +=
      byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c
        ? String.fromCharCode(byte)
        : "\\" + byte.toString(16).padStart(2, "0");
  }
  return text + '"';
}
