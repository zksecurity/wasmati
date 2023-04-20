import { Binable, iso, record, tuple } from "./binable.js";
import * as Dependency from "./dependency.js";
import { U32, vec, withByteLength } from "./immediate.js";
import { ResolvedInstruction } from "./instruction/base.js";
import { Expression } from "./instruction/binable.js";
import {
  LocalContext,
  StackVar,
  formatStack,
  popStack,
  withContext,
} from "./local-context.js";
import {
  FunctionIndex,
  FunctionType,
  JSValue,
  Local,
  Type,
  TypeIndex,
  ValueType,
  valueTypeLiterals,
} from "./types.js";
import { Tuple } from "./util.js";
import { Func } from "./func-types.js";

// external
export { func, Local };
// internal
export { FinalizedFunc, Code, JSFunction, ToTypeTuple };

function func<
  Args extends Tuple<ValueType>,
  Locals extends Tuple<ValueType>,
  Results extends Tuple<ValueType>
>(
  ctx: LocalContext,
  signature: {
    in: ToTypeTuple<Args>;
    locals?: ToTypeTuple<Locals>;
    out: ToTypeTuple<Results>;
  },
  run: (args: ToLocal<Args>, locals: ToLocal<Locals>, ctx: LocalContext) => void
): Func<Args, Results> {
  let {
    in: args,
    locals = [] as ToTypeTuple<Locals>,
    out: results,
  } = signature;
  ctx.stack = [];
  let argsArray = valueTypeLiterals(args);
  let localsArray = valueTypeLiterals(locals);
  let resultsArray = valueTypeLiterals(results);
  let type: { args: Args; results: Results } & FunctionType = {
    args: argsArray as any,
    results: resultsArray as any,
  };
  let nArgs = argsArray.length;
  let argsInput = argsArray.map(
    (type, index): Local<ValueType> => ({
      kind: "local",
      type,
      index,
    })
  ) as ToLocal<Args>;
  let { sortedLocals, localIndices } = sortLocals(localsArray, nArgs);
  let localsInput = localIndices.map(
    (index, j): Local<ValueType> => ({
      kind: "local",
      type: localsArray[j],
      index,
    })
  ) as ToLocal<Locals>;
  let stack: StackVar<ValueType>[] = [];
  let { body, deps } = withContext(
    ctx,
    {
      locals: [...argsArray, ...sortedLocals],
      body: [],
      deps: [],
      stack,
      return: resultsArray,
      frames: [
        {
          label: "top",
          opcode: "function",
          stack,
          startTypes: argsArray,
          endTypes: resultsArray,
          unreachable: false,
        },
      ],
    },
    () => {
      run(argsInput, localsInput, ctx);
      popStack(ctx, resultsArray);
      // TODO nice error
      if (ctx.stack.length !== 0)
        throw Error(
          `expected stack to be empty, got ${formatStack(ctx.stack)}`
        );
    }
  );
  let func = {
    kind: "function",
    type,
    body,
    deps,
    locals: sortedLocals,
  } satisfies Dependency.Func;
  return func;
}

// type inference of function signature

// example:
// type Test = JSFunction<Func<["i64", "i32"], ["i32"]>>;
// ^ (arg_0: bigint, arg_1: number) => number

type ObjectValues<T> = UnionToTuple<T[keyof T]>;

type JSValues<T extends readonly ValueType[]> = {
  [i in keyof T]: JSValue<T[i]>;
};
type ReturnValues<T extends readonly ValueType[]> = T extends []
  ? void
  : T extends [ValueType]
  ? JSValue<T[0]>
  : JSValues<T>;

type JSFunctionType_<Args extends ValueType[], Results extends ValueType[]> = (
  ...arg: JSValues<Args>
) => ReturnValues<Results>;

type JSFunction<T extends Dependency.AnyFunc> = JSFunctionType_<
  T["type"]["args"],
  T["type"]["results"]
>;

type ToLocal<T extends Tuple<ValueType>> = {
  [K in keyof T]: Local<T[K]>;
};
type ToTypeRecord<T extends Record<string, ValueType>> = {
  [K in keyof T]: { kind: T[K] };
};
type ToTypeTuple<T extends readonly ValueType[]> = {
  [K in keyof T]: Type<T[K]>;
};

// bad hack :/

type UnionToIntersection<U> = (
  U extends any ? (arg: U) => any : never
) extends (arg: infer I) => void
  ? I
  : never;

type UnionToTuple<T> = UnionToIntersection<
  T extends any ? (t: T) => T : never
> extends (_: any) => infer W
  ? [...UnionToTuple<Exclude<T, W>>, W]
  : [];

type FinalizedFunc = {
  funcIdx: FunctionIndex;
  typeIdx: TypeIndex;
  type: FunctionType;
  locals: ValueType[];
  body: ResolvedInstruction[];
};

// helper

function sortLocals(locals: ValueType[], offset: number) {
  let typeIndex: Record<string, number> = {};
  let nextIndex = 0;
  let count: number[] = [];
  let offsetWithin: number[] = [];
  for (let local of locals) {
    if (typeIndex[local] === undefined) {
      typeIndex[local] = nextIndex;
      nextIndex++;
    }
    let i = typeIndex[local];
    count[i] ??= 0;
    offsetWithin.push(count[i]);
    count[i]++;
  }
  let typeOffset: number[] = Array(count.length).fill(0);
  for (let i = 1; i < count.length; i++) {
    typeOffset[i] = count[i - 1] + typeOffset[i - 1];
  }
  let localIndices: number[] = [];
  for (let j = 0; j < locals.length; j++) {
    localIndices[j] =
      offset + typeOffset[typeIndex[locals[j]]] + offsetWithin[j];
  }
  let sortedLocals: ValueType[] = Object.entries(typeIndex).flatMap(
    ([type, i]) => Array(count[i]).fill(type as ValueType)
  );
  return { sortedLocals, localIndices };
}

// binable

const CompressedLocals = vec(tuple([U32, ValueType]));
const Locals = iso<[number, ValueType][], ValueType[]>(CompressedLocals, {
  to(locals) {
    let count: Record<string, number> = {};
    for (let local of locals) {
      count[local] ??= 0;
      count[local]++;
    }
    return Object.entries(count).map(([kind, count]) => [
      count,
      kind as ValueType,
    ]);
  },
  from(compressed) {
    let locals: ValueType[] = [];
    for (let [count, local] of compressed) {
      locals.push(...Array(count).fill(local));
    }
    return locals;
  },
});

type Code = { locals: ValueType[]; body: Expression };
const Code = withByteLength(
  record({ locals: Locals, body: Expression })
) satisfies Binable<Code>;
