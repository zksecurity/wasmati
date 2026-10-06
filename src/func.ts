import { Binable, iso, record, tuple } from "./binable.ts";
import type * as Dependency from "./dependency.ts";
import { U32, vec, withByteLength } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import { Expression } from "./instruction/binable.ts";
import {
  type LocalContext,
  StackVar,
  formatStack,
  popStack,
  withContext,
} from "./local-context.ts";
import {
  FunctionIndex,
  FunctionType,
  type JSValue,
  type Local,
  type Type,
  TypeIndex,
  ValueType,
  valueTypeLiteral,
  valueTypeLiterals,
} from "./types.ts";
import type { Tuple } from "./util.ts";
import type { Func } from "./func-types.ts";

// external
export { func, type Local };
// internal
export { type FinalizedFunc, Code, type JSFunction, type ToTypeTuple, type ToTypeRecord };

/**
 * Declare named parameters and locals, preserving each key's Wasm type in the callback.
 * Parameter order follows Object.keys(signature.in). Local names follow their indices after grouping by type.
 * An explicit signature.name or a named callback supplies the internal function's debug name; exports provide a fallback.
 */
function func<
  const Args extends Record<string, ValueType> = {},
  const Results extends Tuple<ValueType> = [],
  const Locals extends Record<string, ValueType> = {}
>(
  ctx: LocalContext,
  signature: {
    name?: string;
    in: ToTypeRecord<Args>;
    locals?: ToTypeRecord<Locals>;
    out: ToTypeTuple<Results>;
  },
  run: (args: ToLocal<Args>, locals: ToLocal<Locals>, ctx: LocalContext) => void
): Func<Args, Results> {
  let {
    in: args,
    locals = {} as ToTypeRecord<Locals>,
    out: results,
  } = signature;
  ctx.stack = [];
  const argNames = Object.keys(args);
  const localKeys = Object.keys(locals);
  const params = Object.fromEntries(
    argNames.map((name) => [name, valueTypeLiteral(args[name])])
  ) as unknown as Args;
  let argsArray = Object.values(params);
  let localsArray = localKeys.map((name) => valueTypeLiteral(locals[name]));
  let resultsArray = valueTypeLiterals<Results>(results);
  let type = { args: argsArray, results: resultsArray };
  let nArgs = argsArray.length;
  const argsInput = Object.fromEntries(argNames.map((name, index) => [
    name, { kind: "local", type: params[name], index } satisfies Local,
  ])) as ToLocal<Args>;
  let { sortedLocals, localIndices } = sortLocals(localsArray, nArgs);
  const localsInput = Object.fromEntries(localKeys.map((name, j) => [
    name, { kind: "local", type: localsArray[j], index: localIndices[j] } satisfies Local,
  ])) as ToLocal<Locals>;
  const localNames = Object.fromEntries([
    ...argNames.map((name, index) => [index, name]),
    ...localKeys.map((name, j) => [localIndices[j], name]),
  ]);
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
  const name = signature.name ?? (run.name || undefined);
  let func = {
    kind: "function",
    params,
    ...(name === undefined ? {} : { name }),
    localNames,
    type,
    body,
    deps,
    locals: sortedLocals,
  } satisfies Dependency.Func;
  return func;
}

// Named parameters retain each key's exact type; result tuples retain arity.
type JSValues<T extends readonly ValueType[]> = {
  [i in keyof T]: JSValue<T[i]>;
};
type ReturnValues<T extends readonly ValueType[]> = T extends []
  ? void
  : T extends [ValueType]
  ? JSValue<T[0]>
  : JSValues<T>;

type JSFunction<T extends Dependency.AnyFunc> = keyof T["params"] extends never
  ? () => ReturnValues<T["type"]["results"]>
  : (args: { [K in keyof T["params"]]: JSValue<T["params"][K]> }) => ReturnValues<T["type"]["results"]>;

type ToLocal<T extends Record<string, ValueType>> = {
  [K in keyof T]: Local<T[K]>;
};
type ToTypeRecord<T extends Record<string, ValueType>> = {
  [K in keyof T]: Type<T[K]>;
};
type ToTypeTuple<T extends readonly ValueType[]> = {
  [K in keyof T]: Type<T[K]>;
};

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
