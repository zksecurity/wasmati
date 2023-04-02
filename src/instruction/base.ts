import { Binable, Undefined } from "../binable.js";
import * as Dependency from "../dependency.js";
import {
  LocalContext,
  popStack,
  pushInstruction,
  RandomLabel,
  withContext,
} from "../local-context.js";
import {
  FunctionType,
  ValueType,
  valueTypeLiterals,
  ValueTypeObject,
  ValueTypeObjects,
} from "../types.js";
import { Tuple } from "../util.js";
import { InstructionName, nameToOpcode } from "./opcodes.js";

export {
  instruction,
  instructionWithArg,
  baseInstruction,
  BaseInstruction,
  ResolvedInstruction,
  resolveInstruction,
  resolveExpression,
  createExpressionWithType,
  FunctionTypeInput,
  lookupInstruction,
  lookupOpcode,
  lookupSubcode,
  typeFromInput,
  Instruction,
  isInstruction,
};

const nameToInstruction: Record<string, BaseInstruction> = {};
const opcodeToInstruction: Record<
  number,
  BaseInstruction | Record<number, BaseInstruction>
> = {};

type BaseInstruction = {
  string: string;
  opcode: number | [number, number];
  immediate: Binable<any> | undefined;
  resolve: (deps: number[], ...args: any) => any;
};
type ResolvedInstruction = { name: string; immediate: any };

/**
 * most general function to create instructions
 */
function baseInstruction<
  Immediate,
  CreateArgs extends Tuple<any>,
  ResolveArgs extends Tuple<any>,
  Args extends Tuple<ValueType> | ValueType[],
  Results extends Tuple<ValueType> | ValueType[]
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
    };
    resolve?(deps: number[], ...args: ResolveArgs): Immediate;
  }
): (
  ctx: LocalContext,
  ...createArgs: CreateArgs
) => Instruction<Args, Results> {
  resolve ??= noResolve;
  let opcode = nameToOpcode[string];
  let instruction = { string, opcode, immediate, resolve };
  nameToInstruction[string] = instruction;
  if (typeof opcode === "number") {
    opcodeToInstruction[opcode] = instruction;
  } else {
    opcodeToInstruction[opcode[0]] ??= {} as Record<number, BaseInstruction>;
    (opcodeToInstruction[opcode[0]] as Record<number, BaseInstruction>)[
      opcode[1]
    ] = instruction;
  }

  return function instruction(ctx: LocalContext, ...createArgs: CreateArgs) {
    let {
      in: args,
      out: results,
      deps = [],
      resolveArgs = createArgs,
    } = create(ctx, ...createArgs);
    pushInstruction(ctx, {
      string,
      deps,
      type: { args, results },
      resolveArgs,
    });
    return { in: args, out: results };
  };
}

function isInstruction(
  value: BaseInstruction | Record<number, BaseInstruction>
): value is BaseInstruction {
  return "opcode" in value;
}

type Instruction<Args, Results> = { in: Args; out: Results };

/**
 * instruction that is completely fixed
 */
function instruction<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>
>(
  string: InstructionName,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>
) {
  let instr = { in: valueTypeLiterals(args), out: valueTypeLiterals(results) };
  return baseInstruction<undefined, [], [], Args, Results>(string, Undefined, {
    create: () => instr,
  });
}

/**
 * instruction of constant type without dependencies,
 * but with an immediate argument
 */
function instructionWithArg<
  Args extends Tuple<ValueType>,
  Results extends Tuple<ValueType>,
  Immediate extends any
>(
  string: InstructionName,
  immediate: Binable<Immediate> | undefined,
  args: ValueTypeObjects<Args>,
  results: ValueTypeObjects<Results>
) {
  immediate = immediate === Undefined ? undefined : immediate;
  type CreateArgs = Immediate extends undefined ? [] : [immediate: Immediate];
  let instr = {
    in: valueTypeLiterals(args),
    out: valueTypeLiterals(results),
  };
  return baseInstruction<Immediate, CreateArgs, CreateArgs, Args, Results>(
    string,
    immediate,
    { create: () => instr }
  );
}

function resolveInstruction(
  { string, deps, resolveArgs }: Dependency.Instruction,
  depToIndex: Map<Dependency.t, number>
): ResolvedInstruction {
  let instr = lookupInstruction(string);
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
  return { name: string, immediate };
}

const noResolve = (_: number[], ...args: any) => args[0];

// TODO: the input type is simply taken as the current stack, which could be much larger than the minimal needed input type
// to compute the minimal type signature, local context needs to keep track of the minimum stack height
// function createExpression(
//   name: LocalContext["frames"][number]["opcode"],
//   ctx: LocalContext,
//   run: (label: RandomLabel) => void
// ): {
//   body: Dependency.Instruction[];
//   type: FunctionType;
//   deps: Dependency.t[];
// } {
//   let args = [...ctx.stack];
//   let stack = [...ctx.stack];
//   let label = String(Math.random()) as RandomLabel;
//   let { stack: results, body } = withContext(
//     ctx,
//     {
//       body: [],
//       stack,
//       frames: [
//         {
//           label,
//           opcode: name,
//           startTypes: null,
//           endTypes: null,
//           unreachable: false,
//           stack,
//         },
//         ...ctx.frames,
//       ],
//     },
//     () => run(label)
//   );
//   return { body, type: { args, results }, deps: body.flatMap((i) => i.deps) };
// }

type FunctionTypeInput = {
  in?: ValueTypeObject[];
  out?: ValueTypeObject[];
} | null;

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
  run: (label: RandomLabel) => void
): {
  body: Dependency.Instruction[];
  type: FunctionType;
  deps: Dependency.t[];
} {
  let args = valueTypeLiterals(type?.in ?? []);
  let results = valueTypeLiterals(type?.out ?? []);
  let stack = [...args];
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
    () => run(label)
  );
  popStack(subCtx, results);
  if (stack.length !== 0)
    throw Error(
      `expected stack to be empty at the end of block, got [${stack}]`
    );
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

function lookupSubcode(
  opcode: number,
  subcode: number,
  codes: Record<number, BaseInstruction>
) {
  let instr = codes[subcode];
  if (instr === undefined)
    throw Error(`invalid opcode (${opcode}, ${subcode})`);
  return instr;
}
