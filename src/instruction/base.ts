import { Binable, Undefined, Writer } from "../binable.ts";
import type { Code, Immediate } from "../code.ts";
import type * as Dependency from "../dependency.ts";
import {
  formatStack,
  type LocalContext,
  placeResults,
  popStack,
  popTypes,
  pushResult,
  pushStack,
  type RandomLabel,
  StackVar,
  stackVars,
  withContext,
} from "../local-context.ts";
import {
  type DefinedType,
  type Local,
  FunctionType,
  isFunctionType,
  referencedTypes,
  ValueType,
  valueTypeLiterals,
  type ValueTypeObject,
  type ValueTypeObjects,
} from "../types.ts";
import type { Tuple } from "../util.ts";
import { type InstructionName, nameToOpcode } from "./opcodes.ts";

export {
  withPublicSignature,
  type WithPublicSignature,
  baseInstructionWithImmediate,
  baseInstruction,
  type BaseInstruction,
  type ResolvedInstruction,
  type Description,
  emit,
  emitSimple,
  writeInstruction,
  runBlock,
  checkAllowed,
  hasDefinedType,
  type FunctionTypeInput,
  nameToInstruction,
  opcodeToInstruction,
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

const nameToInstruction: Record<string, BaseInstruction> = {};
const opcodeToInstruction: Record<number, BaseInstruction | Record<number, BaseInstruction>> = {};

type BaseInstruction = Immediate & {
  opcode: number | [number, number];
  immediate: Binable<any> | undefined;
  /** The opcode's encoding. */
  opcodeBytes: Uint8Array;
  /** Whether the immediate may contain defined types, which Module() replaces by their indices. */
  typed: boolean;
  /** What the instruction changes that operands of later instructions may read. */
  effect?: "local" | "global" | "call" | "direct call";
};

/** An instruction with its operands and results, and what its immediate is made of. */
type Description = {
  string: string;
  instruction: BaseInstruction;
  type: FunctionType;
  deps: Dependency.t[];
  resolveArgs: any[];
  likely?: boolean;
};

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

function effectOf(name: string): BaseInstruction["effect"] {
  if (name === "local.set" || name === "local.tee") return "local";
  if (name === "global.set") return "global";
  if (name === "call" || name === "return_call") return "direct call";
  if (name.startsWith("call") || name.startsWith("return_call")) return "call";
  return undefined;
}
/** An instruction with its immediate; `if` and `br_if` may carry a branch hint. */
type ResolvedInstruction = { name: string; immediate: any; likely?: boolean };

/**
 * Most general function to create instructions
 */
function baseInstruction<
  Immediate,
  CreateArgs extends Tuple<any>,
  ResolveArgs extends Tuple<any>,
  Args extends Tuple<ValueType> | ValueType[],
  Results extends Tuple<ValueType> | ValueType[],
>(
  string: InstructionName,
  immediate: Binable<Immediate> | undefined = undefined,
  {
    create,
    resolve,
  }: {
    create(
      ctx: LocalContext,
      ...args: CreateArgs
    ): {
      in: Args;
      out: Results;
      deps?: Dependency.t[];
      resolveArgs?: ResolveArgs;
      likely?: boolean;
    };
    resolve?(deps: number[], ...args: ResolveArgs): Immediate;
  },
): ((ctx: LocalContext, ...createArgs: CreateArgs) => Instruction_<Args, Results>) & {
  create(ctx: LocalContext, ...createArgs: CreateArgs): Description;
  instruction: BaseInstruction;
} {
  resolve ??= noResolve;
  let opcode = nameToOpcode[string];
  let opcodeBytes = new Writer(8);
  if (typeof opcode === "number") opcodeBytes.byte(opcode);
  else {
    opcodeBytes.byte(opcode[0]);
    opcodeBytes.unsigned(opcode[1]);
  }
  let instruction: BaseInstruction = {
    string,
    opcode,
    opcodeBytes: opcodeBytes.result(),
    immediate,
    resolve,
    typed: typedInstructions.has(string),
    effect: effectOf(string),
  };
  nameToInstruction[string] = instruction;
  if (typeof opcode === "number") {
    opcodeToInstruction[opcode] = instruction;
  } else {
    opcodeToInstruction[opcode[0]] ??= {} as Record<number, BaseInstruction>;
    (opcodeToInstruction[opcode[0]] as Record<number, BaseInstruction>)[opcode[1]] = instruction;
  }

  function wrapCreate(ctx: LocalContext, ...createArgs: CreateArgs): Description {
    let {
      in: args,
      out: results,
      deps = [],
      resolveArgs = createArgs,
      likely,
    } = create(ctx, ...createArgs);
    return { string, instruction, type: { args, results }, deps, resolveArgs, likely };
  }

  /**
   * Calling an instruction validates its operands on the stack, writes it to the code, and pushes its
   * results. `create()` only describes it, with its operand and result types.
   */
  return Object.assign(
    function (ctx: LocalContext, ...createArgs: CreateArgs) {
      let results = emit(ctx, wrapCreate(ctx, ...createArgs));
      // The results are the stack entries, so that operands can be checked to be where they are.
      return (
        results.length === 0 ? undefined : results.length === 1 ? results[0] : results
      ) as Instruction_<Args, Results>;
    },
    { create: wrapCreate, instruction },
  );
}

/** Apply an instruction to the stack, write it to the code, and return its results. */
function emit(
  ctx: LocalContext,
  { instruction, type, deps, resolveArgs, likely }: Description,
): StackVar<ValueType>[] {
  let { code } = ctx;
  checkAllowed(ctx, instruction.string);
  let start = code.length;
  popTypes(ctx, type.args, instruction.string);
  writeInstruction(code, instruction, deps, resolveArgs, likely);
  for (let dep of deps) ctx.deps.add(dep);
  if (instruction.effect === "direct call") ctx.calls.add(deps[0] as Dependency.AnyFunc);
  let results = pushStack(ctx, type.results) as StackVar<ValueType>[];
  placeResults(ctx, start);
  return results;
}

/**
 * Apply and write an instruction without dependencies, whose immediate, if any, is given, and which
 * pushes at most one result: most instructions. Faster than `emit()`, which handles all.
 */
function emitSimple(
  ctx: LocalContext,
  instruction: BaseInstruction,
  args: ValueType[],
  result: ValueType | undefined,
  immediate?: unknown,
): StackVar<ValueType> | undefined {
  let { code } = ctx;
  if (ctx.allowed !== undefined) checkAllowed(ctx, instruction.string);
  let start = code.length;
  if (args.length > 0) popTypes(ctx, args, instruction.string);
  let { opcodeBytes } = instruction;
  if (opcodeBytes.length === 1) code.byte(opcodeBytes[0]);
  else code.bytes(opcodeBytes);
  if (instruction.immediate !== undefined) instruction.immediate.write(code, immediate);
  if (instruction.effect === "local")
    code.writes.push({ position: start, name: instruction.string, local: immediate as number });
  if (result !== undefined) return pushResult(ctx, result, start);
  placeResults(ctx, start);
  return undefined;
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
  let start = code.length;
  if (likely !== undefined) code.hints.push({ position: start, likely });
  let { opcodeBytes, immediate, effect } = instruction;
  if (opcodeBytes.length === 1) code.byte(opcodeBytes[0]);
  else code.bytes(opcodeBytes);
  if (immediate !== undefined) {
    if (deps.some(hasIndex)) code.hole(instruction, deps, args);
    else {
      let value = instruction.resolve(deps.map(noIndex), ...args);
      if (instruction.typed && hasDefinedType(value)) code.hole(instruction, deps, args);
      else immediate.write(code, value);
    }
  }
  if (effect !== undefined) {
    let name = instruction.string;
    if (effect === "local")
      code.writes.push({ position: start, name, local: (args[0] as Local).index });
    else if (effect === "global")
      code.writes.push({ position: start, name, global: deps[0] as Dependency.AnyGlobal });
    else code.writes.push({ position: start, name, call: true });
  }
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

/**
 * Instruction of constant type without dependencies,
 * but with an immediate argument.
 *
 * Allows passing a validation callback for the immediate value.
 */
function baseInstructionWithImmediate<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>,
  Immediate extends any,
>(
  name: InstructionName,
  immediate: Binable<Immediate> | undefined,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>,
  validateImmediate?: (immediate: Immediate) => void,
) {
  immediate = immediate === Undefined ? undefined : immediate;
  type CreateArgs = Immediate extends undefined ? [] : [immediate: Immediate];
  let instr = {
    in: valueTypeLiterals<Args>(args),
    out: valueTypeLiterals<Results>(results),
  };

  let base = baseInstruction<Immediate, CreateArgs, CreateArgs, Args, Results>(name, immediate, {
    create:
      // validate immediate if we have a validation callback
      validateImmediate && immediate !== undefined
        ? (_ctx, ...args) => {
            validateImmediate(args[0] as Immediate);
            return instr;
          }
        : () => instr,
  });
  if (instr.out.length > 1) return base;
  let { instruction } = base;
  let [result] = instr.out;
  return Object.assign(
    function (ctx: LocalContext, ...[value]: CreateArgs) {
      if (validateImmediate !== undefined && immediate !== undefined)
        validateImmediate(value as Immediate);
      return emitSimple(ctx, instruction, instr.in, result, value) as Instruction_<Args, Results>;
    },
    { create: base.create, instruction },
  );
}

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
  let stack = stackVars(args, ctx.code.length);
  let label: RandomLabel = `0.${labels++}`;
  let frame = {
    label,
    opcode: name,
    startTypes: args,
    endTypes: results,
    unreachable: false,
    stack,
  };
  let inner = withContext(ctx, { stack, frames: [frame, ...ctx.frames] }, () => run(label));
  popStack(inner, results);
  if (stack.length !== 0)
    throw Error(`expected stack to be empty at the end of block, got ${formatStack(stack)}`);
}
