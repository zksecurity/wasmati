import "../index.ts";
import * as C from "../codec.ts";
import { Undefined } from "../binable.ts";
import { lookupInstruction } from "../instruction/base.ts";
import { TextSyntaxError, UnsupportedTextError } from "./lexer.ts";
import { F32, F64 } from "./float.ts";
import { Atom, I32, I64, U32, type Expression } from "./text.ts";
import {
  form,
  head,
  Index,
  optional,
  position,
  repeated,
  token,
  ValueType,
  word,
  type IndexValue,
  record,
  isIndex,
} from "./grammar.ts";
import type { ValueType as Type } from "../types.ts";

export { Instructions, TypeUse, LocalGroup, label };
export type { Instruction, TypeUse as TypeUseValue, LocalGroup as LocalGroupValue };

type LocalGroup = { name: string | undefined; types: Type[] };
import { Identifier } from "./text.ts";
const label = optional(
  token(Identifier),
  (node) => !Array.isArray(node) && node?.kind === "identifier",
);
const LocalGroup = C.withValidation(
  record({ name: label, types: C.sequence(ValueType) }),
  (group) => {
    if (group.name !== undefined && group.types.length !== 1) {
      throw new TextSyntaxError("a named parameter or local requires exactly one type");
    }
  },
);
type TypeUse = { index: IndexValue | undefined; params: LocalGroup[]; results: Type[][] };
const TypeUse = record({
  index: optional(form("type", Index), (node) => head(node) === "type"),
  params: repeated(form("param", LocalGroup), "param"),
  results: repeated(form("result", C.sequence(ValueType)), "result"),
});

type Instruction = {
  name: string;
  immediate?: unknown;
  label?: string;
  type?: TypeUse;
  body?: Instruction[];
  else?: Instruction[];
};

const indexOps = new Set([
  "local.get",
  "local.set",
  "local.tee",
  "global.get",
  "global.set",
  "call",
  "ref.func",
  "br",
  "br_if",
]);

/** Decode both flat and folded instructions into one stack-style instruction sequence. */
const Instructions: C.Codec<Instruction[], Expression> = {
  encode(instructions) {
    return instructions.flatMap((instruction) => {
      const { name } = instruction;
      if (name === "block" || name === "loop" || name === "if") {
        return [
          ...token(Atom).encode(name),
          ...label.encode(instruction.label),
          ...TypeUse.encode(instruction.type!),
          ...Instructions.encode(instruction.body!),
          ...(instruction.else === undefined
            ? []
            : [...token(Atom).encode("else"), ...Instructions.encode(instruction.else)]),
          ...token(Atom).encode("end"),
        ];
      }
      let immediate: Expression[] = [];
      if (indexOps.has(name)) immediate = Index.encode(instruction.immediate as IndexValue);
      else if (name === "i32.const") immediate = token(I32).encode(instruction.immediate as number);
      else if (name === "i64.const") immediate = token(I64).encode(instruction.immediate as bigint);
      else if (name === "f32.const") immediate = token(F32).encode(instruction.immediate as number);
      else if (name === "f64.const") immediate = token(F64).encode(instruction.immediate as number);
      else if (name === "call_indirect") {
        const value = instruction.immediate as { table?: IndexValue; type: TypeUse };
        immediate = [...Index.encode(value.table ?? 0), ...TypeUse.encode(value.type)];
      } else if (name === "memory.size" || name === "memory.grow" || name === "memory.fill") {
        immediate = Index.encode(instruction.immediate as IndexValue);
      } else if (/^[if](32|64)\.(load|store)/.test(name)) {
        const { align, offset } = instruction.immediate as { align: number; offset: number };
        immediate = [
          ...token(Atom).encode(`offset=${offset}`),
          ...token(Atom).encode(`align=${2 ** align}`),
        ];
      } else if (name === "br_table")
        immediate = C.sequence(Index).encode(instruction.immediate as IndexValue[]);
      else if (name === "ref.null")
        immediate = token(Atom).encode(instruction.immediate === "funcref" ? "func" : "extern");
      else if (name === "select_t")
        immediate = form("result", C.sequence(ValueType)).encode(instruction.immediate as Type[]);
      else if (instruction.immediate !== undefined) {
        throw new UnsupportedTextError(`text printing of ${name} is not implemented`);
      }
      return [...token(Atom).encode(name === "select_t" ? "select" : name), ...immediate];
    });
  },
  decode(input, start) {
    let offset = start;
    const instructions: Instruction[] = [];
    const take = <T>(codec: C.Codec<T, Expression>): T => {
      const [value, end] = codec.decode(input, offset);
      offset = end;
      return value;
    };
    const optionalLabel = () => take(label);
    while (offset < input.length && !["end", "else"].includes(word(input[offset]) ?? "")) {
      const node = input[offset];
      if (Array.isArray(node)) {
        // Folded operands execute left-to-right before their enclosing instruction.
        const folded = decodeFolded(node);
        instructions.push(...folded);
        offset++;
        continue;
      }
      const name = take(token(Atom));
      if (name === "block" || name === "loop" || name === "if") {
        const nameLabel = optionalLabel();
        const type = take(TypeUse);
        const body = take(Instructions);
        let elseBody: Instruction[] | undefined;
        if (name === "if" && word(input[offset]) === "else") {
          offset++;
          const elseLabel = optionalLabel();
          if (elseLabel !== undefined && elseLabel !== nameLabel)
            throw new TextSyntaxError("mismatched else label");
          elseBody = take(Instructions);
        }
        if (word(input[offset]) !== "end")
          throw new TextSyntaxError(`expected end for ${name}`, position(input[offset]));
        offset++;
        const endLabel = optionalLabel();
        if (endLabel !== undefined && endLabel !== nameLabel)
          throw new TextSyntaxError("mismatched end label");
        instructions.push({ name, label: nameLabel, type, body, else: elseBody });
      } else {
        instructions.push(readPlain(name, take, () => input[offset]));
      }
    }
    return [instructions, offset];
  },
};

function readPlain(
  name: string,
  take: <T>(codec: C.Codec<T, Expression>) => T,
  peek: () => Expression | undefined,
): Instruction {
  if (indexOps.has(name)) return { name, immediate: take(Index) };
  if (name === "i32.const") return { name, immediate: take(token(I32)) };
  if (name === "i64.const") return { name, immediate: take(token(I64)) };
  if (name === "f32.const") return { name, immediate: take(token(F32)) };
  if (name === "f64.const") return { name, immediate: take(token(F64)) };
  if (name === "call_indirect") {
    return { name, immediate: take(record({ table: optional(Index, isIndex), type: TypeUse })) };
  }
  if (name === "memory.size" || name === "memory.grow" || name === "memory.fill") {
    return { name, immediate: take(optional(Index, isIndex)) ?? 0 };
  }
  if (/^[if](32|64)\.(load|store)/.test(name)) {
    const match = name.match(/^[if](32|64)\.(?:load|store)(8|16|32)?/)!;
    let align = Math.log2(Number(match[2] ?? match[1]) / 8);
    let offset = 0;
    let sawAlign = false;
    let sawOffset = false;
    while (/^(offset|align)=/.test(word(peek()) ?? "")) {
      const field = take(token(Atom));
      const [key, literal] = field.split("=");
      const value = U32.fromText(literal);
      if (key === "offset") {
        if (sawOffset || sawAlign)
          throw new TextSyntaxError("offset must appear once, before align");
        sawOffset = true;
        offset = value;
      } else {
        if (sawAlign || value === 0 || !Number.isInteger(Math.log2(value)))
          throw new TextSyntaxError("invalid memory alignment");
        sawAlign = true;
        align = Math.log2(value);
      }
    }
    return { name, immediate: { align, offset } };
  }
  if (name === "br_table") {
    const indices = take(
      C.repeatWhile(Index, (input, offset) => {
        const node = input[offset];
        return (
          !Array.isArray(node) &&
          node !== undefined &&
          (node.kind === "identifier" || /^[0-9]/.test(node.text))
        );
      }),
    );
    if (indices.length === 0) throw new TextSyntaxError("br_table requires a default label");
    return { name, immediate: indices };
  }
  if (name === "ref.null") {
    const type = take(token(Atom));
    if (type !== "func" && type !== "extern")
      throw new UnsupportedTextError(`unsupported heap type ${type}`);
    return { name, immediate: type === "func" ? "funcref" : "externref" };
  }
  if (name === "select" && head(peek()) === "result") {
    return { name: "select_t", immediate: take(form("result", C.sequence(ValueType))) };
  }
  const instruction = lookupInstruction(name);
  if (instruction.immediate !== undefined && instruction.immediate !== Undefined)
    throw new UnsupportedTextError(`text immediate for ${name} is not implemented`);
  return { name };
}

function decodeFolded(node: Expression[]): Instruction[] {
  let offset = 0;
  const take = <T>(codec: C.Codec<T, Expression>): T => {
    const [value, end] = codec.decode(node, offset);
    offset = end;
    return value;
  };
  const name = take(token(Atom));
  if (name === "block" || name === "loop" || name === "if") {
    const nameLabel = take(label);
    const type = take(TypeUse);
    if (name !== "if") {
      const body = take(Instructions);
      if (offset !== node.length)
        throw new TextSyntaxError(`unexpected field in folded ${name}`, position(node[offset]));
      return [{ name, label: nameLabel, type, body }];
    }
    const operands: Instruction[] = [];
    while (head(node[offset]) !== "then" && offset < node.length) {
      if (!Array.isArray(node[offset]))
        throw new TextSyntaxError("expected folded if operand", position(node[offset]));
      operands.push(...decodeFolded(node[offset++] as Expression[]));
    }
    const body = take(form("then", Instructions));
    const elseBody = take(optional(form("else", Instructions), (node) => head(node) === "else"));
    if (offset !== node.length)
      throw new TextSyntaxError("unexpected field in folded if", position(node[offset]));
    return [...operands, { name, label: nameLabel, type, body, else: elseBody }];
  }
  const instruction = readPlain(name, take, () => node[offset]);
  const operands: Instruction[] = [];
  while (offset < node.length) {
    const operand = node[offset++];
    if (!Array.isArray(operand))
      throw new TextSyntaxError("expected folded operand", position(operand));
    operands.push(...decodeFolded(operand));
  }
  return [...operands, instruction];
}
