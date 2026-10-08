import {
  Binable,
  byteCursor,
  readByte,
  writeByte,
  writeUnsignedLEB,
  writtenBytes,
} from "./binable.ts";
import { U32, vec } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import { ELSE, END, Instruction } from "./instruction/binable.ts";
import { FunctionCode, type Code } from "./code-section.ts";
import { Locals } from "./func.ts";

export { encodeBranchHints, decodeBranchHints, encodeCode, branchHintSection, type Hint };

/**
 * Branch hints are code metadata: a custom section that refers to `if` and `br_if` instructions by
 * their byte offset in the function, from the start of its locals. In modules, hints are recorded on
 * the instructions themselves.
 */
const branchHintSection = "metadata.code.branch_hint";

/** A branch hint, by the offset of its instruction from the start of the function's code. */
type Hint = { offset: number; likely: boolean };
type FunctionHints = { func: number; hints: Hint[] };

const BranchHints = vec(
  Binable<FunctionHints>({
    writeBytes(output, { func, hints }) {
      writeUnsignedLEB(output, func);
      Hints.writeBytes(output, hints);
    },
    readBytes(input) {
      let func = U32.readBytes(input);
      return { func, hints: Hints.readBytes(input) };
    },
  }),
);

/** A hint's payload is one byte: 1 if the branch is likely taken, 0 if not. */
const Hint = Binable<Hint>({
  writeBytes(output, { offset, likely }) {
    writeUnsignedLEB(output, offset);
    writeByte(output, 1);
    writeByte(output, likely ? 1 : 0);
  },
  readBytes(input) {
    let offset = U32.readBytes(input);
    let size = U32.readBytes(input);
    let value = readByte(input);
    if (size !== 1 || value > 1) throw Error("malformed branch hint");
    return { offset, likely: value === 1 };
  },
});

const Hints = vec(Hint);

/** The custom section of the functions' branch hints, if any; `firstFunc` is the first function's index. */
function encodeBranchHints(funcs: { hints: Hint[] }[], firstFunc: number): Uint8Array | undefined {
  let functions = funcs.flatMap(({ hints }, i): FunctionHints[] =>
    hints.length === 0 ? [] : [{ func: firstFunc + i, hints }],
  );
  return functions.length === 0 ? undefined : BranchHints.toBytes(functions);
}

/**
 * A function's encoded code, and the offsets of its branch hints from its start, which are recorded
 * on its `if` and `br_if` instructions.
 */
function encodeCode(code: Code): { code: Uint8Array; hints: Hint[] } {
  if (!hasHints(code.body)) return { code: FunctionCode.toBytes(code), hints: [] };
  let { offsets, bytes } = encodeWithOffsets(
    code,
    (instruction) => instruction.likely !== undefined,
  );
  let hints = offsets.map(([instruction, offset]) => {
    if (instruction.name !== "if" && instruction.name !== "br_if")
      throw Error(`branch hint on ${instruction.name}: only if and br_if take hints`);
    return { offset, likely: instruction.likely! };
  });
  return { code: bytes, hints };
}

/** Whether instructions, or those in their blocks, have branch hints. */
function hasHints(body: ResolvedInstruction[]): boolean {
  return body.some(({ name, likely, immediate }) => {
    if (likely !== undefined) return true;
    if (name === "block" || name === "loop" || name === "try_table")
      return hasHints(immediate.instructions);
    if (name === "if")
      return hasHints(immediate.instructions.if) || hasHints(immediate.instructions.else ?? []);
    return false;
  });
}

/** Record the section's hints on the instructions they refer to; throws if the section is invalid. */
function decodeBranchHints(data: Uint8Array, codes: Code[], firstFunc: number) {
  let assignments: [ResolvedInstruction, boolean][] = [];
  for (let { func, hints } of BranchHints.fromBytes(data)) {
    let code = codes[func - firstFunc];
    if (code === undefined) throw Error(`branch hint for unknown function ${func}`);
    let instructions = new Map(
      encodeWithOffsets(code, () => true).offsets.map(([instruction, offset]) => [
        offset,
        instruction,
      ]),
    );
    for (let { offset, likely } of hints) {
      let instruction = instructions.get(offset);
      if (instruction?.name !== "if" && instruction?.name !== "br_if")
        throw Error(`branch hint at offset ${offset} is not on if or br_if`);
      assignments.push([instruction, likely]);
    }
  }
  for (let [instruction, likely] of assignments) instruction.likely = likely;
}

/**
 * The encoding of a function's code, and the selected instructions with their byte offsets from its
 * start, where its locals are.
 */
function encodeWithOffsets(
  { locals, body }: Code,
  select: (instruction: ResolvedInstruction) => boolean,
): {
  offsets: [ResolvedInstruction, number][];
  bytes: Uint8Array;
} {
  let offsets: [ResolvedInstruction, number][] = [];
  let output = byteCursor();
  Locals.writeBytes(output, locals);
  // A block's header is its encoding with empty bodies, without the final `end`.
  const header = (instruction: ResolvedInstruction, empty: unknown) => {
    Instruction.writeBytes(output, {
      ...instruction,
      immediate: { ...instruction.immediate, instructions: empty },
    });
    output.offset--;
  };
  const walk = (body: ResolvedInstruction[]) => {
    for (let instruction of body) {
      if (select(instruction)) offsets.push([instruction, output.offset]);
      let { name, immediate } = instruction;
      if (name === "block" || name === "loop" || name === "try_table") {
        header(instruction, []);
        walk(immediate.instructions);
        writeByte(output, END);
      } else if (name === "if") {
        header(instruction, { if: [] });
        walk(immediate.instructions.if);
        if (immediate.instructions.else !== undefined) {
          writeByte(output, ELSE);
          walk(immediate.instructions.else);
        }
        writeByte(output, END);
      } else Instruction.writeBytes(output, instruction);
    }
  };
  walk(body);
  writeByte(output, END);
  return { offsets, bytes: writtenBytes(output) };
}
