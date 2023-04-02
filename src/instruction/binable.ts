import { Binable, constant, or, record, withByteCode } from "../binable.js";
import { S33, U32 } from "../immediate.js";
import { ValueType } from "../types.js";
import {
  BaseInstruction,
  isInstruction,
  lookupInstruction,
  lookupOpcode,
  lookupSubcode,
  ResolvedInstruction,
} from "./base.js";

export { Expression, ConstExpression, Block, IfBlock };

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

const Empty = withByteCode(0x40, constant<"empty">("empty"));

type BlockType = "empty" | ValueType | U32;
const BlockType = or([Empty, S33, ValueType], (t) =>
  t === "empty" ? Empty : typeof t === "number" ? S33 : ValueType
);

const Block = record({ blockType: BlockType, instructions: Expression });
const IfBlock = record({ blockType: BlockType, instructions: IfExpression });
