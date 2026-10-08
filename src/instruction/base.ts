import { Binable, Undefined, writeByte, writeByteArray } from "../binable.ts";
import { type Code, type Immediate, addHole } from "../code.ts";
import type * as Dependency from "../dependency.ts";
import {
  checkSynchronous,
  formatStack,
  type LocalContext,
  popStack,
  type RandomLabel,
  StackVar,
  stackVars,
  withContext,
} from "../local-context.ts";
import {
  type DefinedType,
  FunctionType,
  isFunctionType,
  referencedTypes,
  ValueType,
  valueTypeLiterals,
  type ValueTypeObject,
} from "../types.ts";
import { type InstructionName, nameToOpcode } from "./opcodes.ts";

export {
  withPublicSignature,
  type WithPublicSignature,
  define,
  type BaseInstruction,
  type ResolvedInstruction,
  writeInstruction,
  emitInstruction,
  runBlock,
  checkAllowed,
  hasDefinedType,
  type FunctionTypeInput,
  typeFromInput,
  functionTypeOf,
  type FunctionTypeReference,
  type Instruction,
  isInstruction,
  type Instruction_,
};

/**
 * Instructions may declare the signature of their public API, without the context argument. Generic
 * signatures keep their type parameters there, which removing the context from the full signature
 * loses. This is a type only: the property does not exist at runtime.
 */
declare const publicSignature: unique symbol;
type WithPublicSignature<Signature> = { readonly [publicSignature]?: Signature };

function withPublicSignature<Signature>() {
  return <F>(instruction: F) => instruction as F & WithPublicSignature<Signature>;
}

type BaseInstruction = Immediate & {
  opcode: number | [number, number];
  immediate: Binable<any> | undefined;
  /** The opcode's encoding: for opcodes with a prefix, the prefix byte and the LEB128 subcode. */
  opcodeBytes: number[];
  /** Whether the immediate may contain defined types, which Module() replaces by their indices. */
  typed: boolean;
  /** Whether the instruction calls a function directly, which async exports must know. */
  directCall: boolean;
};

/** Instructions whose immediates may contain defined types, which `TypeRegistry.immediate()` replaces. */
const typedInstructions = new Set([
  "ref.null",
  "ref.test",
  "ref.test_null",
  "ref.cast",
  "ref.cast_null",
  "br_on_cast",
  "br_on_cast_fail",
  "select_t",
]);

/** An instruction with its immediate; `if` and `br_if` may carry a branch hint. */
type ResolvedInstruction = { name: string; immediate: any; likely?: boolean };

/**
 * An instruction's definition: its name, opcode and immediate, which encoding, decoding and lookups by
 * name or opcode use. `resolve` gives the immediate from the indices of the instruction's
 * dependencies, which Module() knows, and further arguments; by default, it is the first argument.
 */
function define(
  string: InstructionName,
  immediate?: Binable<any>,
  resolve: (deps: number[], ...args: any) => any = noResolve,
): BaseInstruction {
  let opcode = nameToOpcode[string];
  // A prefix byte and an unsigned LEB128 subcode, below 2^14 for all instructions.
  let opcodeBytes =
    typeof opcode === "number"
      ? [opcode]
      : opcode[1] < 0x80
        ? [opcode[0], opcode[1]]
        : [opcode[0], (opcode[1] & 0x7f) | 0x80, opcode[1] >> 7];
  return {
    string,
    opcode,
    opcodeBytes,
    immediate: immediate === Undefined ? undefined : immediate,
    resolve,
    typed: typedInstructions.has(string),
    directCall: string === "call" || string === "return_call",
  };
}

/**
 * Write an instruction: its opcode, and its immediate, or a hole for it if it refers to other
 * definitions by index. Memory 0 and function references have no index of their own.
 */
function writeInstruction(
  code: Code,
  instruction: BaseInstruction,
  deps: Dependency.t[],
  args: any[],
  likely?: boolean,
) {
  if (likely !== undefined) code.hints.push({ position: code.offset, likely });
  let { opcodeBytes, immediate } = instruction;
  if (opcodeBytes.length === 1) writeByte(code, opcodeBytes[0]);
  else writeByteArray(code, opcodeBytes);
  if (immediate !== undefined) {
    if (deps.length > 0 && deps.some(hasIndex)) addHole(code, instruction, deps, args);
    else {
      let value = instruction.resolve(deps.length === 0 ? noDeps : deps.map(noIndex), ...args);
      if (instruction.typed && hasDefinedType(value)) addHole(code, instruction, deps, args);
      else immediate.writeBytes(code, value);
    }
  }
}

/**
 * Write an instruction, with its immediate, or a hole for it where it refers to other definitions, and
 * record its dependencies and the function it calls directly.
 */
function emitInstruction(
  ctx: LocalContext,
  instruction: BaseInstruction,
  deps: Dependency.t[],
  args: unknown[],
) {
  for (let i = 0; i < deps.length; i++) ctx.deps.add(deps[i]);
  if (instruction.directCall) ctx.calls.add(deps[0] as Dependency.AnyFunc);
  writeInstruction(ctx.code, instruction, deps, args);
}

/** Constant expressions allow only some instructions. */
function checkAllowed(ctx: LocalContext, name: string) {
  if (ctx.allowed !== undefined && !ctx.allowed.has(name))
    throw Error(`constant: ${name} is not a constant instruction`);
}

function hasIndex(dep: Dependency.t) {
  return dep.kind !== "hasMemory" && dep.kind !== "hasRefTo";
}
const noIndex = () => 0;
const noDeps: number[] = [];

/** Whether a value contains defined types, which Module() replaces by their indices. */
function hasDefinedType(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if ((value as { kind?: unknown }).kind === "type") return true;
  return Object.values(value).some(hasDefinedType);
}

function isInstruction(
  value: BaseInstruction | Record<number, BaseInstruction>,
): value is BaseInstruction {
  return "opcode" in value;
}

type Instruction<Args, Results> = {
  [i in keyof Results]: StackVar<Results[i]>;
} & { in?: Args };

type Instruction_<Args, Results> = Results extends []
  ? void
  : Results extends [ValueType]
    ? StackVar<Results[0]>
    : Instruction<Args, Results>;

const noResolve = (_: number[], ...args: any) => args[0];

type FunctionTypeInput = {
  in?: ValueTypeObject[];
  out?: ValueTypeObject[];
} | null;

/** A function type: a signature, or a defined type such as a subtype or a type of a recursion group. */
type FunctionTypeReference = FunctionTypeInput | DefinedType;

/** The signature and defined type of a function type reference. */
function functionTypeOf(reference: FunctionTypeReference): {
  type: FunctionType;
  defined: DefinedType;
} {
  if (reference !== null && "kind" in reference) {
    if (!isFunctionType(reference.type)) throw Error("expected a function type");
    return { type: reference.type, defined: reference };
  }
  let type = typeFromInput(reference);
  return { type, defined: { kind: "type", type, deps: referencedTypes(type) } };
}

function typeFromInput(type: FunctionTypeInput): FunctionType {
  return {
    args: valueTypeLiterals(type?.in ?? []),
    results: valueTypeLiterals(type?.out ?? []),
  };
}

let labels = 0;

/**
 * Run the body of a block of the given type, whose code follows in place, in a frame of its own. Its
 * results must be all that its body leaves on its stack.
 */
function runBlock(
  ctx: LocalContext,
  name: LocalContext["frames"][number]["opcode"],
  { args, results }: FunctionType,
  run: (label: RandomLabel) => void,
) {
  let stack = stackVars(args);
  let label: RandomLabel = `0.${labels++}`;
  let frame = {
    label,
    opcode: name,
    startTypes: args,
    endTypes: results,
    unreachable: false,
    stack,
  };
  let inner = withContext(ctx, { stack, frames: [frame, ...ctx.frames] }, () =>
    checkSynchronous(run(label), name),
  );
  popStack(inner, results);
  if (stack.length !== 0)
    throw Error(`expected stack to be empty at the end of block, got ${formatStack(stack)}`);
}
