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

export { Expression, ConstExpression, Block, IfBlock, TryTable, type Catch };

const Instruction = Binable<ResolvedInstruction>({
  toBytes({ name, immediate }) {
    let instr = lookupInstruction(name);
    let imm: number[] = [];
    if (instr.immediate !== undefined) {
      imm = instr.immediate.toBytes(immediate);
    }
    if (typeof instr.opcode === "number") return [instr.opcode, ...imm];
    return [instr.opcode[0], ...U32.toBytes(instr.opcode[1]), ...imm];
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
type Expression = ResolvedInstruction[];
const Expression = Binable<ResolvedInstruction[]>({
  toBytes(t) {
    let instructions = t.map(Instruction.toBytes).flat();
    instructions.push(END);
    return instructions;
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
  toBytes(t) {
    let instructions = t.if.map(Instruction.toBytes).flat();
    if (t.else !== undefined) {
      instructions.push(ELSE, ...t.else.map(Instruction.toBytes).flat());
    }
    instructions.push(END);
    return instructions;
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
  toBytes(clause) {
    let code = catchKinds.indexOf(clause.kind);
    let tag = "tag" in clause ? U32.toBytes(clause.tag) : [];
    return [code, ...tag, ...U32.toBytes(clause.label)];
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
