import { Binable, Byte, Writer } from "./binable.ts";
import { U32, vec } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import { ELSE, END, Instruction, rememberEncoding } from "./instruction/binable.ts";
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
    write(writer, { func, hints }) {
      writer.unsigned(func);
      Hints.write(writer, hints);
    },
    readBytes(bytes, offset) {
      let func: number, hints: FunctionHints["hints"];
      [func, offset] = U32.readBytes(bytes, offset);
      [hints, offset] = Hints.readBytes(bytes, offset);
      return [{ func, hints }, offset];
    },
  }),
);

/** A hint's payload is one byte: 1 if the branch is likely taken, 0 if not. */
const Hint = Binable<{ offset: number; likely: boolean }>({
  write(writer, { offset, likely }) {
    writer.unsigned(offset);
    writer.byte(1);
    writer.byte(likely ? 1 : 0);
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

const Hints = vec(Hint);

/**
 * The custom section of the functions' branch hints, if any; `firstFunc` is the first function's index.
 * Functions that are encoded already know their hints' offsets.
 */
function encodeBranchHints<C>(
  codes: C[],
  firstFunc: number,
  encoded: (code: C) => { offset: number; likely: boolean }[] | undefined,
): number[] | undefined {
  let functions = codes.flatMap((entry, i): FunctionHints[] => {
    let known = encoded(entry);
    if (known !== undefined)
      return known.length === 0 ? [] : [{ func: firstFunc + i, hints: known }];
    let code = entry as Code;
    if (!hasHints(code.body)) return [];
    // Offsets are measured by encoding the function, and the code section reuses the encoding.
    let { offsets, bytes } = encodeWithOffsets(
      code,
      (instruction) => instruction.likely !== undefined,
    );
    rememberEncoding(code.body, bytes);
    let hints = offsets.map(([instruction, offset]) => {
      if (instruction.name !== "if" && instruction.name !== "br_if")
        throw Error(`branch hint on ${instruction.name}: only if and br_if take hints`);
      return { offset, likely: instruction.likely! };
    });
    return [{ func: firstFunc + i, hints }];
  });
  return functions.length === 0 ? undefined : BranchHints.toBytes(functions);
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
function decodeBranchHints(data: number[], codes: Code[], firstFunc: number) {
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
 * The encoding of a function's body, and the selected instructions with their byte offsets from the
 * start of the locals.
 */
function encodeWithOffsets(
  { locals, body }: Code,
  select: (instruction: ResolvedInstruction) => boolean,
): {
  offsets: [ResolvedInstruction, number][];
  bytes: Uint8Array;
} {
  let offsets: [ResolvedInstruction, number][] = [];
  let writer = new Writer();
  let start = Locals.encode(locals).length;
  // A block's header is its encoding with empty bodies, without the final `end`.
  const header = (instruction: ResolvedInstruction, empty: unknown) => {
    Instruction.write(writer, {
      ...instruction,
      immediate: { ...instruction.immediate, instructions: empty },
    });
    writer.length--;
  };
  const walk = (body: ResolvedInstruction[]) => {
    for (let instruction of body) {
      if (select(instruction)) offsets.push([instruction, start + writer.length]);
      let { name, immediate } = instruction;
      if (name === "block" || name === "loop" || name === "try_table") {
        header(instruction, []);
        walk(immediate.instructions);
        writer.byte(END);
      } else if (name === "if") {
        header(instruction, { if: [] });
        walk(immediate.instructions.if);
        if (immediate.instructions.else !== undefined) {
          writer.byte(ELSE);
          walk(immediate.instructions.else);
        }
        writer.byte(END);
      } else Instruction.write(writer, instruction);
    }
  };
  walk(body);
  writer.byte(END);
  return { offsets, bytes: writer.result() };
}
