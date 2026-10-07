import { Binable, Byte } from "./binable.ts";
import { U32, vec } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import { Instruction } from "./instruction/binable.ts";
import { Locals } from "./func.ts";
import type { ValueType } from "./types.ts";

export { encodeBranchHints, decodeBranchHints, branchHintSection };

/**
 * Branch hints are code metadata: a custom section that refers to `if` and `br_if` instructions by
 * their byte offset in the function, from the start of its locals. In modules, hints are recorded on
 * the instructions themselves.
 */
const branchHintSection = "metadata.code.branch_hint";

type Code = { locals: ValueType[]; body: ResolvedInstruction[] };
type FunctionHints = { func: number; hints: { offset: number; likely: boolean }[] };

const BranchHints = vec(
  Binable<FunctionHints>({
    toBytes({ func, hints }) {
      return [...U32.toBytes(func), ...vec(Hint).toBytes(hints)];
    },
    readBytes(bytes, offset) {
      let func: number, hints: FunctionHints["hints"];
      [func, offset] = U32.readBytes(bytes, offset);
      [hints, offset] = vec(Hint).readBytes(bytes, offset);
      return [{ func, hints }, offset];
    },
  }),
);

/** A hint's payload is one byte: 1 if the branch is likely taken, 0 if not. */
const Hint = Binable<{ offset: number; likely: boolean }>({
  toBytes({ offset, likely }) {
    return [...U32.toBytes(offset), ...U32.toBytes(1), likely ? 1 : 0];
  },
  readBytes(bytes, offset) {
    let position: number, size: number, value: number;
    [position, offset] = U32.readBytes(bytes, offset);
    [size, offset] = U32.readBytes(bytes, offset);
    [value, offset] = Byte.readBytes(bytes, offset);
    if (size !== 1 || value > 1) throw Error("malformed branch hint");
    return [{ offset: position, likely: value === 1 }, offset];
  },
});

/** The custom section of the functions' branch hints, if any; `firstFunc` is the first function's index. */
function encodeBranchHints(codes: Code[], firstFunc: number): number[] | undefined {
  let functions = codes.flatMap((code, i): FunctionHints[] => {
    let hints = instructionOffsets(code).flatMap(([instruction, offset]) => {
      if (instruction.likely === undefined) return [];
      if (instruction.name !== "if" && instruction.name !== "br_if")
        throw Error(`branch hint on ${instruction.name}: only if and br_if take hints`);
      return [{ offset, likely: instruction.likely }];
    });
    return hints.length === 0 ? [] : [{ func: firstFunc + i, hints }];
  });
  return functions.length === 0 ? undefined : BranchHints.toBytes(functions);
}

/** Record the section's hints on the instructions they refer to; throws if the section is invalid. */
function decodeBranchHints(data: number[], codes: Code[], firstFunc: number) {
  let assignments: [ResolvedInstruction, boolean][] = [];
  for (let { func, hints } of BranchHints.fromBytes(data)) {
    let code = codes[func - firstFunc];
    if (code === undefined) throw Error(`branch hint for unknown function ${func}`);
    let instructions = new Map(
      instructionOffsets(code).map(([instruction, offset]) => [offset, instruction]),
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

/** Each instruction with its byte offset, measured with the instruction codec. */
function instructionOffsets({ locals, body }: Code): [ResolvedInstruction, number][] {
  let offsets: [ResolvedInstruction, number][] = [];
  let offset = Locals.toBytes(locals).length;
  // A block's header is its encoding with empty bodies, without the final `end`.
  const header = (instruction: ResolvedInstruction, empty: unknown) =>
    Instruction.toBytes({
      ...instruction,
      immediate: { ...instruction.immediate, instructions: empty },
    }).length - 1;
  const walk = (body: ResolvedInstruction[]) => {
    for (let instruction of body) {
      offsets.push([instruction, offset]);
      let { name, immediate } = instruction;
      if (name === "block" || name === "loop" || name === "try_table") {
        offset += header(instruction, []);
        walk(immediate.instructions);
        offset += 1;
      } else if (name === "if") {
        offset += header(instruction, { if: [] });
        walk(immediate.instructions.if);
        if (immediate.instructions.else !== undefined) {
          offset += 1;
          walk(immediate.instructions.else);
        }
        offset += 1;
      } else offset += Instruction.toBytes(instruction).length;
    }
  };
  walk(body);
  return offsets;
}
