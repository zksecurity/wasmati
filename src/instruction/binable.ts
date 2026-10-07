import { Binable, constant, or, record, withByteCode } from "../binable.ts";
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
  Catch,
  BlockType,
};

const Instruction = Binable<ResolvedInstruction>({
  write(writer, { name, immediate }) {
    let instr = lookupInstruction(name);
    if (typeof instr.opcode === "number") writer.byte(instr.opcode);
    else {
      writer.byte(instr.opcode[0]);
      writer.unsigned(instr.opcode[1]);
    }
    if (instr.immediate !== undefined) instr.immediate.write(writer, immediate);
  },
  readBytes(bytes, offset) {
    let opcode = bytes[offset++];
    let instr_ = lookupOpcode(opcode);
    let instr: BaseInstruction;
    if (isInstruction(instr_)) instr = instr_;
    else {
      let subcode: number;
      [subcode, offset] = U32.readBytes(bytes, offset);
      instr = lookupSubcode(opcode, subcode, instr_);
    }
    if (instr.immediate === undefined)
      return [{ name: instr.string, immediate: undefined }, offset];
    let [immediate, end] = instr.immediate.readBytes(bytes, offset);
    return [{ name: instr.string, immediate }, end];
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
  write(writer, t) {
    let encoded = encodings.get(t);
    if (encoded !== undefined) {
      encodings.delete(t);
      writer.bytes(encoded);
      return;
    }
    for (let i = 0; i < t.length; i++) Instruction.write(writer, t[i]);
    writer.byte(END);
  },
  readBytes(bytes, offset) {
    let instructions: ResolvedInstruction[] = [];
    while (bytes[offset] !== END) {
      let instr: ResolvedInstruction;
      [instr, offset] = Instruction.readBytes(bytes, offset);
      instructions.push(instr);
    }
    return [instructions, offset + 1];
  },
});

const ELSE = 0x05;
type IfExpression = {
  if: ResolvedInstruction[];
  else?: ResolvedInstruction[];
};
const IfExpression = Binable<IfExpression>({
  write(writer, t) {
    for (let instruction of t.if) Instruction.write(writer, instruction);
    if (t.else !== undefined) {
      writer.byte(ELSE);
      for (let instruction of t.else) Instruction.write(writer, instruction);
    }
    writer.byte(END);
  },
  readBytes(bytes, offset) {
    let t: IfExpression = { if: [], else: undefined };
    let instructions = t.if;
    while (true) {
      if (bytes[offset] === ELSE) {
        instructions = t.else = [];
        offset++;
        continue;
      } else if (bytes[offset] === END) {
        offset++;
        break;
      }
      let instr: ResolvedInstruction;
      [instr, offset] = Instruction.readBytes(bytes, offset);
      instructions.push(instr);
    }
    return [t, offset];
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
  write(writer, clause) {
    writer.byte(catchKinds.indexOf(clause.kind));
    if ("tag" in clause) writer.unsigned(clause.tag);
    writer.unsigned(clause.label);
  },
  readBytes(bytes, offset) {
    let kind = catchKinds[bytes[offset++]];
    if (kind === undefined) throw Error("malformed catch clause");
    if (kind === "catch_all" || kind === "catch_all_ref") {
      let [label, end] = U32.readBytes(bytes, offset);
      return [{ kind, label }, end];
    }
    let [tag, afterTag] = U32.readBytes(bytes, offset);
    let [label, end] = U32.readBytes(bytes, afterTag);
    return [{ kind, tag, label }, end];
  },
});
const TryTable = record({ blockType: BlockType, catches: vec(Catch), instructions: Expression });
const IfBlock = record({ blockType: BlockType, instructions: IfExpression });
