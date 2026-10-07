import "../index.ts";
import { Byte, Undefined } from "../binable.ts";
import { F32, F64, I32, I64, U8, type U64 } from "../immediate.ts";
import { lookupInstruction, type ResolvedInstruction } from "../instruction/base.ts";
import { Block, IfBlock } from "../instruction/binable.ts";
import { RefType, type IndexSpace, type ValueType } from "../types.ts";
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

export { parseInstructions, printInstructions, parseValueType, printString };
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
};

/** What printing needs: identifiers by index space, if an index has one. */
type Names = { id(space: IndexSpace, index: number): string | undefined };

const blocks = new Set(["block", "loop", "if"]);
const valueTypes = new Set<string>(["i32", "i64", "f32", "f64", "v128", "funcref", "externref"]);
// Valid instructions of features that wasmati's module representation does not support yet.
const unsupported =
  /^(return_call|call_ref|throw|try_table|rethrow|struct\.|array\.|ref\.(i31|test|cast|as_non_null|eq)$|i31\.|any\.|extern\.|br_on_|[a-z0-9]+\.relaxed_)/;

function parseValueType(c: Cursor): ValueType {
  if (c.peekHead() === "ref") throw new UnsupportedTextError("typed references are not supported");
  const node = c.peek();
  const type = c.atom();
  if (valueTypes.has(type)) return type as ValueType;
  if (/^(any|eq|i31|struct|array|none|nofunc|noextern|exn|noexn|null\w*)ref$/.test(type))
    throw new UnsupportedTextError(`value type ${type} is not supported`);
  return c.fail(`unknown value type ${type}`, node);
}

/** Read instructions, flat or folded, until the list ends or a block delimiter follows. */
function parseInstructions(c: Cursor, scope: Scope): ResolvedInstruction[] {
  const body: ResolvedInstruction[] = [];
  while (!c.done && c.peekAtom() !== "end" && c.peekAtom() !== "else") instruction(c, scope, body);
  return body;
}

function instruction(c: Cursor, scope: Scope, body: ResolvedInstruction[]) {
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
  const nested = { ...scope, labels: [label, ...scope.labels] };
  const instructions = parseInstructions(c, nested);
  let otherwise: ResolvedInstruction[] | undefined;
  if (name === "if" && c.maybeKeyword("else")) {
    endLabel(c, label);
    otherwise = parseInstructions(c, nested);
  }
  c.keyword("end");
  endLabel(c, label);
  body.push(block(name, blockType, instructions, otherwise));
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
  const nested = { ...scope, labels: [label, ...scope.labels] };
  if (name !== "if") {
    body.push(block(name, blockType, parseInstructions(c, nested)));
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
  body.push(block(name, blockType, instructions, elseBody));
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
  otherwise?: ResolvedInstruction[],
): ResolvedInstruction {
  return name === "if"
    ? { name, immediate: { blockType, instructions: { if: instructions, else: otherwise } } }
    : { name, immediate: { blockType, instructions } };
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

/** An instruction without a body. `select` with result types is the typed `select_t`. */
function plain(name: string, c: Cursor, scope: Scope): ResolvedInstruction {
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
    case RefType: {
      const type = c.atom();
      if (type === "func" || type === "extern") return `${type}ref`;
      throw new UnsupportedTextError(`heap type ${type} is not supported`);
    }
    case Block:
    case IfBlock:
      throw Error("unreachable");
  }
  switch (string) {
    case "br_table": {
      const indices: number[] = [];
      do indices.push(label(c, scope));
      while (c.peekIndex());
      return { indices: indices.slice(0, -1), defaultIndex: indices.at(-1)! };
    }
    case "call_indirect": {
      const table = c.peekIndex() ? scope.index(c, "table") : 0;
      return [scope.typeUse(c), table];
    }
    case "select_t":
      return c.lists("result", (result) => result.until(parseValueType)).flat();
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
  }
  throw new UnsupportedTextError(`text immediate of ${string} is not implemented`);
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
      return width === 32 ? F32.toBytes(value as F32) : F64.toBytes(value as F64);
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
  return body.flatMap(({ name, immediate }) => {
    if (blocks.has(name)) {
      const head = [name, ...blockType(immediate.blockType)].join(" ");
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
    const text = name === "select_t" ? "select" : name;
    return [indent + [text, ...printImmediate(name, immediate, names)].join(" ")];
  });
}

function blockType(type: BlockType): string[] {
  if (type === "empty") return [];
  return typeof type === "number" ? [`(type ${type})`] : [`(result ${type})`];
}

function printImmediate(name: string, value: any, names: Names): string[] {
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
    case RefType:
      return [value === "funcref" ? "func" : "extern"];
  }
  switch (name) {
    case "br_table":
      return [...value.indices, value.defaultIndex].map(String);
    case "call_indirect":
      return [...(value[1] === 0 ? [] : [id("table", value[1])]), `(type ${value[0]})`];
    case "select_t":
      return [`(result ${value.join(" ")})`];
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
