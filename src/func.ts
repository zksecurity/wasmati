import { Binable, iso, record, tuple } from "./binable.js";
import * as Dependency from "./dependency.js";
import { U32, vec, withByteLength } from "./immediate.js";
import { ResolvedInstruction } from "./instruction/base.js";
import { Expression } from "./instruction/binable.js";
import { LocalContext, popStack, withContext } from "./local-context.js";
import {
  FunctionIndex,
  FunctionType,
  JSValue,
  TypeIndex,
  ValueType,
  valueTypeLiterals,
} from "./types.js";
import { Tuple } from "./util.js";

// external
export { func };
// internal
export { FinalizedFunc, Code, JSFunctionType, ToTypeTuple };

type Func<
  Args extends Record<string, ValueType>,
  Results extends readonly ValueType[]
> = {
  kind: "function";
  locals: ValueType[];
  body: Dependency.Instruction[];
  deps: Dependency.t[];
  type: FullFunctionType<Args, Results>;
};

function func<
  Args extends Record<string, ValueType>,
  Locals extends Record<string, ValueType>,
  Results extends Tuple<ValueType>
>(
  ctx: LocalContext,
  {
    in: args,
    locals,
    out: results,
  }: {
    in: ToTypeRecord<Args>;
    locals: ToTypeRecord<Locals>;
    out: ToTypeTuple<Results>;
  },
  run: (args: ToLocal<Args>, locals: ToLocal<Locals>, ctx: LocalContext) => void
): Func<Args, Results> {
  ctx.stack = [];
  let argsArray = valueTypeLiterals(Object.values(args));
  let localsArray = valueTypeLiterals(Object.values(locals));
  let resultsArray = valueTypeLiterals(results);
  let type: FullFunctionType<Args, Results> & FunctionType = {
    args: argsArray as any,
    results: resultsArray as any,
  };
  let nArgs = argsArray.length;
  let argsInput = Object.fromEntries(
    Object.entries(args).map(([key], index) => [key, { index }])
  ) as ToLocal<Args>;
  let localsInput = Object.fromEntries(
    Object.entries(locals).map(([key], index) => [
      key,
      { index: index + nArgs },
    ])
  ) as ToLocal<Locals>;
  let stack: ValueType[] = [];
  let { body, deps } = withContext(
    ctx,
    {
      locals: [...argsArray, ...localsArray],
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
        throw Error(`expected stack to be empty, got [${ctx.stack}]`);
    }
  );
  let func = {
    kind: "function",
    type,
    body,
    deps,
    locals: localsArray,
  } satisfies Dependency.Func;
  return func;
}

// type inference of function signature

// example:
// type Test = JSFunctionType<FullFunctionType<{ x: "i64"; y: "i32" }, ["i32"]>>;
//       ^ (arg_0: bigint, arg_1: number) => number

type FullFunctionType<
  Args extends Record<string, ValueType>,
  Results extends readonly ValueType[]
> = {
  args: [...ObjValueTuple<Args>];
  results: Results;
};

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

type JSFunctionType<T extends FunctionType> = JSFunctionType_<
  T["args"],
  T["results"]
>;

type Local<L extends ValueType> = { type?: L; index: number };

type ToLocal<T extends Record<string, ValueType>> = {
  [K in keyof T]: Local<T[K]>;
};
type ToTypeRecord<T extends Record<string, ValueType>> = {
  [K in keyof T]: { kind: T[K] };
};
type ToTypeTuple<T extends readonly ValueType[]> = {
  [K in keyof T]: { kind: T[K] };
};

type ObjValueTuple<
  T,
  K extends any[] = UnionToTuple<keyof T>,
  R extends any[] = []
> = K extends [infer K, ...infer KT]
  ? ObjValueTuple<T, KT, [...R, T[K & keyof T]]>
  : R;

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
