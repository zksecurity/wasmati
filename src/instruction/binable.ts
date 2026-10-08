import {
  Binable,
  constant,
  or,
  readByte,
  record,
  withByteCode,
  writeByte,
  writeByteArray,
  writeUnsignedLEB,
} from "../binable.ts";
import { S33, U32, vec } from "../immediate.ts";
import { ValueType } from "../types.ts";
import {
  type BaseInstruction,
  isInstruction,
  lookupInstruction,
  lookupOpcode,
  lookupSubcode,
  type ResolvedInstruction,
} from "./base.ts";

export {
  Instruction,
  Expression,
  END,
  ELSE,
  rememberEncoding,
  ConstExpression,
  Block,
  IfBlock,
  TryTable,
  type Catch,
  type BlockType,
};

const Instruction = Binable<ResolvedInstruction>({
  writeBytes(output, { name, immediate }) {
    let instr = lookupInstruction(name);
    if (typeof instr.opcode === "number") writeByte(output, instr.opcode);
    else {
      writeByte(output, instr.opcode[0]);
      writeUnsignedLEB(output, instr.opcode[1]);
    }
    if (instr.immediate !== undefined) instr.immediate.writeBytes(output, immediate);
  },
  readBytes(input) {
    let opcode = readByte(input);
    let instr_ = lookupOpcode(opcode);
    let instr: BaseInstruction = isInstruction(instr_)
      ? instr_
      : lookupSubcode(opcode, U32.readBytes(input), instr_);
    let immediate = instr.immediate === undefined ? undefined : instr.immediate.readBytes(input);
    return { name: instr.string, immediate };
  },
});

const END = 0x0b;

/**
 * Encodings of expressions that were encoded already, to measure the offsets of branch hints, for
 * the next encoding of the expression only.
 */
const encodings = new WeakMap<ResolvedInstruction[], Uint8Array>();

function rememberEncoding(expression: ResolvedInstruction[], bytes: Uint8Array) {
  encodings.set(expression, bytes);
}
type Expression = ResolvedInstruction[];
const Expression = Binable<ResolvedInstruction[]>({
  writeBytes(output, t) {
    let encoded = encodings.get(t);
    if (encoded !== undefined) {
      encodings.delete(t);
      writeByteArray(output, encoded);
      return;
    }
    for (let i = 0; i < t.length; i++) Instruction.writeBytes(output, t[i]);
    writeByte(output, END);
  },
  readBytes(input) {
    let instructions: ResolvedInstruction[] = [];
    while (input.bytes[input.offset] !== END) instructions.push(Instruction.readBytes(input));
    input.offset++;
    return instructions;
  },
});

const ELSE = 0x05;
type IfExpression = {
  if: ResolvedInstruction[];
  else?: ResolvedInstruction[];
};
const IfExpression = Binable<IfExpression>({
  writeBytes(output, t) {
    for (let instruction of t.if) Instruction.writeBytes(output, instruction);
    if (t.else !== undefined) {
      writeByte(output, ELSE);
      for (let instruction of t.else) Instruction.writeBytes(output, instruction);
    }
    writeByte(output, END);
  },
  readBytes(input) {
    let t: IfExpression = { if: [], else: undefined };
    let instructions = t.if;
    while (true) {
      let byte = input.bytes[input.offset];
      if (byte === ELSE) {
        instructions = t.else = [];
        input.offset++;
      } else if (byte === END) {
        input.offset++;
        return t;
      } else instructions.push(Instruction.readBytes(input));
    }
  },
});

type ConstExpression = Expression;
const ConstExpression = Expression;

const Empty = withByteCode(0x40, constant("empty"));

type BlockType = "empty" | ValueType | U32;
const BlockType = or([Empty, ValueType, S33], (t) =>
  t === "empty" ? Empty : typeof t === "number" ? S33 : ValueType,
);

const Block = record({ blockType: BlockType, instructions: Expression });

/** A catch clause of try_table: which exceptions it catches, and the label it branches to. */
type Catch =
  | { kind: "catch" | "catch_ref"; tag: number; label: number }
  | { kind: "catch_all" | "catch_all_ref"; label: number };
const catchKinds = ["catch", "catch_ref", "catch_all", "catch_all_ref"] as const;
const Catch = Binable<Catch>({
  writeBytes(output, clause) {
    writeByte(output, catchKinds.indexOf(clause.kind));
    if ("tag" in clause) writeUnsignedLEB(output, clause.tag);
    writeUnsignedLEB(output, clause.label);
  },
  readBytes(input) {
    let kind = catchKinds[readByte(input)];
    if (kind === undefined) throw Error("malformed catch clause");
    if (kind === "catch_all" || kind === "catch_all_ref")
      return { kind, label: U32.readBytes(input) };
    let tag = U32.readBytes(input);
    return { kind, tag, label: U32.readBytes(input) };
  },
});
const TryTable = record({ blockType: BlockType, catches: vec(Catch), instructions: Expression });
const IfBlock = record({ blockType: BlockType, instructions: IfExpression });
