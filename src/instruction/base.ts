import { Binable, Undefined } from "../binable.ts";
import type * as Dependency from "../dependency.ts";
import {
  formatStack,
  type LocalContext,
  popStack,
  pushInstruction,
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
  type ValueTypeObjects,
} from "../types.ts";
import type { Tuple } from "../util.ts";
import { type InstructionName, nameToOpcode } from "./opcodes.ts";

export {
  baseInstructionWithImmediate,
  baseInstruction,
  type BaseInstruction,
  type ResolvedInstruction,
  resolveInstruction,
  resolveExpression,
  createExpressionWithType,
  type FunctionTypeInput,
  lookupInstruction,
  lookupOpcode,
  lookupSubcode,
  typeFromInput,
  functionTypeOf,
  type FunctionTypeReference,
  type Instruction,
  isInstruction,
  type Instruction_,
};

const nameToInstruction: Record<string, BaseInstruction> = {};
const opcodeToInstruction: Record<number, BaseInstruction | Record<number, BaseInstruction>> = {};

type BaseInstruction = {
  string: string;
  opcode: number | [number, number];
  immediate: Binable<any> | undefined;
  resolve: (deps: number[], ...args: any) => any;
};
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
  create(ctx: LocalContext, ...createArgs: CreateArgs): Dependency.Instruction;
} {
  resolve ??= noResolve;
  let opcode = nameToOpcode[string];
  let instruction = { string, opcode, immediate, resolve };
  nameToInstruction[string] = instruction;
  if (typeof opcode === "number") {
    opcodeToInstruction[opcode] = instruction;
  } else {
    opcodeToInstruction[opcode[0]] ??= {} as Record<number, BaseInstruction>;
    (opcodeToInstruction[opcode[0]] as Record<number, BaseInstruction>)[opcode[1]] = instruction;
  }

  function wrapCreate(ctx: LocalContext, ...createArgs: CreateArgs): Dependency.Instruction {
    let {
      in: args,
      out: results,
      deps = [],
      resolveArgs = createArgs,
      likely,
    } = create(ctx, ...createArgs);
    return {
      string,
      deps,
      type: { args, results },
      resolveArgs,
      ...(likely === undefined ? {} : { likely }),
    };
  }

  /**
   * "Calling" an instruction does two different things:
   * - creates a `Dependency.Instruction` (that represents the instruction before resolving dependencies)
   *   - how to this is defined by the input `create()` function
   * - applies the instruction to the current stack/ctx, and validates stack types
   *
   * If you only want creation, use `instruction.create()` instead of `instruction()`
   * (this is currently not exposed to the public API)
   */
  return Object.assign(
    function instruction(ctx: LocalContext, ...createArgs: CreateArgs) {
      let instr = wrapCreate(ctx, ...createArgs);
      pushInstruction(ctx, instr);
      let results = instr.type.results;
      return (
        results.length === 0
          ? undefined
          : results.length === 1
            ? StackVar(results[0])
            : results.map(StackVar)
      ) as Instruction_<Args, Results>;
    },
    { create: wrapCreate },
  );
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

  return baseInstruction<Immediate, CreateArgs, CreateArgs, Args, Results>(name, immediate, {
    create:
      // validate immediate if we have a validation callback
      validateImmediate && immediate !== undefined
        ? (_ctx, ...args) => {
            validateImmediate(args[0] as Immediate);
            return instr;
          }
        : () => instr,
  });
}

function resolveInstruction(
  { string: name, deps, resolveArgs, likely }: Dependency.Instruction,
  depToIndex: Map<Dependency.t, number>,
): ResolvedInstruction {
  let instr = lookupInstruction(name);
  let depIndices: number[] = [];
  for (let dep of deps) {
    let index = depToIndex.get(dep);
    if (index === undefined) {
      if (dep.kind === "hasRefTo") index = 0;
      else if (dep.kind === "hasMemory") index = 0;
      else throw Error("bug: no index for dependency");
    }
    depIndices.push(index);
  }
  let immediate = instr.resolve(depIndices, ...resolveArgs);
  return { name, immediate, ...(likely === undefined ? {} : { likely }) };
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

function createExpressionWithType(
  name: LocalContext["frames"][number]["opcode"],
  ctx: LocalContext,
  type: FunctionTypeInput,
  run: (label: RandomLabel) => void,
): {
  body: Dependency.Instruction[];
  type: FunctionType;
  deps: Dependency.t[];
} {
  let args = valueTypeLiterals(type?.in ?? []);
  let results = valueTypeLiterals(type?.out ?? []);
  let stack = stackVars(args);
  let label = String(Math.random()) as RandomLabel;
  let subCtx = withContext(
    ctx,
    {
      body: [],
      stack,
      frames: [
        {
          label,
          opcode: name,
          startTypes: args,
          endTypes: results,
          unreachable: false,
          stack,
        },
        ...ctx.frames,
      ],
    },
    () => run(label),
  );
  popStack(subCtx, results);
  if (stack.length !== 0)
    throw Error(`expected stack to be empty at the end of block, got ${formatStack(stack)}`);
  let { body } = subCtx;
  return { body, type: { args, results }, deps: body.flatMap((i) => i.deps) };
}

function resolveExpression(deps: number[], body: Dependency.Instruction[]) {
  let instructions: ResolvedInstruction[] = [];
  let offset = 0;
  for (let instr of body) {
    let n = instr.deps.length;
    let myDeps = deps.slice(offset, offset + n);
    let instrObject = lookupInstruction(instr.string);
    let immediate = instrObject.resolve(myDeps, ...instr.resolveArgs);
    instructions.push({ name: instr.string, immediate });
    offset += n;
  }
  return instructions;
}

function lookupInstruction(name: string) {
  let instr = nameToInstruction[name];
  if (instr === undefined) throw Error(`invalid instruction name "${name}"`);
  return instr;
}
function lookupOpcode(opcode: number) {
  let instr = opcodeToInstruction[opcode];
  if (instr === undefined) throw Error(`invalid opcode "${opcode}"`);
  return instr;
}

function lookupSubcode(opcode: number, subcode: number, codes: Record<number, BaseInstruction>) {
  let instr = codes[subcode];
  if (instr === undefined) throw Error(`invalid opcode (${opcode}, ${subcode})`);
  return instr;
}
