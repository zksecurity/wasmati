import { iso, tuple } from "./binable.ts";
import { Code } from "./code.ts";
import type * as Dependency from "./dependency.ts";
import { U32, vec } from "./immediate.ts";
import type { ResolvedInstruction } from "./instruction/base.ts";
import {
  type LocalContext,
  StackVar,
  formatStack,
  popStack,
  withContext,
} from "./local-context.ts";
import {
  type DefinedType,
  FunctionIndex,
  FunctionType,
  functionTypeEquals,
  isFunctionType,
  type JSValue,
  type Local,
  type Type,
  TypeIndex,
  ValueType,
  typeEquals,
  valueTypeLiterals,
} from "./types.ts";
import type { Tuple } from "./util.ts";
import {
  createParameters,
  type ParameterInput,
  type ParameterSchema,
  type CheckedParameters,
  type ParameterValues,
} from "./parameters.ts";
import type { LocalDeclaration, NamedLocals } from "./locals.ts";
import type { Func } from "./func-types.ts";

// external
export { func, declareFunc, type Local };
// internal
export {
  type FinalizedFunc,
  Locals,
  type JSFunction,
  type ReturnValues,
  type JSValues,
  type ToTypeTuple,
  explicitType,
};

/**
 * Declare named parameters and locals, preserving each key's Wasm type in the callback.
 * Parameter order follows the input array. Local names follow their indices after grouping by type.
 * An explicit signature.name or a named callback supplies the internal function's debug name; exports provide a fallback.
 */
function func<
  const Args extends readonly ParameterInput[] = [],
  const Results extends Tuple<ValueType> = [],
  const Locals extends Record<string, LocalDeclaration> = {},
>(
  ctx: LocalContext,
  signature: {
    name?: string;
    in: CheckedParameters<Args>;
    locals?: Locals;
    out: ToTypeTuple<Results>;
    /** An explicit function type, such as a subtype; it must match the signature. */
    type?: DefinedType;
  },
  run: (
    args: ToLocal<ParameterValues<ParameterSchema<Args>>>,
    locals: NamedLocals<Locals>,
    ctx: LocalContext,
  ) => void,
): Func<ParameterSchema<Args>, Results> {
  let { in: entries, locals = {} as Locals, out: results } = signature;
  const args = createParameters<Args>(entries);
  ctx.stack = [];
  const { names: argNames, types: argsArray } = args;
  const localEntries = Object.entries(locals);
  const flatLocals = localEntries.flatMap(([name, declaration]) =>
    declaration.kind === "local-array"
      ? Array.from({ length: declaration.length }, (_, index) => ({
          name: `${name}[${index}]`,
          type: declaration.type.kind,
        }))
      : [{ name, type: declaration.kind }],
  );
  const localsArray = flatLocals.map(({ type }) => type);
  const resultsArray = valueTypeLiterals<Results>(results);
  const type = { args: argsArray, results: resultsArray };
  const nArgs = argsArray.length;
  const argsInput = Object.fromEntries(
    argNames.map((name, index) => [
      name,
      { kind: "local", type: argsArray[index], index } satisfies Local,
    ]),
  ) as ToLocal<ParameterValues<ParameterSchema<Args>>>;
  const { sortedLocals, localIndices } = sortLocals(localsArray, nArgs);
  let offset = 0;
  const localsInput = Object.fromEntries(
    localEntries.map(([name, declaration]) => {
      const isArray = declaration.kind === "local-array";
      const length = isArray ? declaration.length : 1;
      const values = Array.from({ length }, () => {
        const j = offset++;
        return { kind: "local", type: localsArray[j], index: localIndices[j] } satisfies Local;
      });
      return [name, isArray ? values : values[0]];
    }),
  ) as NamedLocals<Locals>;
  const localNames = Object.fromEntries([
    ...argNames.map((name, index) => [index, name]),
    ...flatLocals.map(({ name }, j) => [localIndices[j], name]),
  ]);
  const name = signature.name ?? (run.name || undefined);
  let stack: StackVar<ValueType>[] = [];
  let code = new Code();
  let deps = new Set<Dependency.t>();
  let calls = new Set<Dependency.AnyFunc>();
  withContext(
    ctx,
    {
      locals: [...argsArray, ...sortedLocals],
      code,
      deps,
      calls,
      allowed: undefined,
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
      // The function's results must be all that is left on the stack.
      const end = `end of function${name === undefined ? "" : ` ${name}`}`;
      popStack(ctx, resultsArray, end);
      if (ctx.stack.length !== 0)
        throw Error(
          `${end}: expected stack to be empty after the results, got ${formatStack(ctx.stack)}`,
        );
    },
  );
  let func = {
    kind: "function",
    params: args,
    ...(name === undefined ? {} : { name }),
    localNames,
    type,
    ...explicitType(signature.type, type),
    code,
    deps: [...deps],
    calls: [...calls] as Func<any, any>["calls"],
    locals: sortedLocals,
    defined: true,
  } satisfies Dependency.Func;
  return func;
}

/**
 * Declare a function before its body, allowing forward calls and mutual recursion.
 * define() builds the body with the same typed parameters/locals as func(), preserving identity.
 * Every declaration must be defined exactly once before constructing its Module.
 */
function declareFunc<
  const Args extends readonly ParameterInput[] = [],
  const Results extends Tuple<ValueType> = [],
  const Locals extends Record<string, LocalDeclaration> = {},
>(
  ctx: LocalContext,
  signature: {
    name?: string;
    in: CheckedParameters<Args>;
    locals?: Locals;
    out: ToTypeTuple<Results>;
    /** An explicit function type, such as a subtype; it must match the signature. */
    type?: DefinedType;
  },
) {
  const args = createParameters<Args>(signature.in);
  const type = { args: args.types, results: valueTypeLiterals<Results>(signature.out) };
  const declaration: Func<ParameterSchema<Args>, Results> = {
    kind: "function",
    params: args,
    type,
    ...explicitType(signature.type, type),
    name: signature.name,
    locals: [],
    code: new Code(0),
    deps: [],
    calls: [],
    defined: false,
  };
  return Object.assign(declaration, {
    define(
      run: (
        args: ToLocal<ParameterValues<ParameterSchema<Args>>>,
        locals: NamedLocals<Locals>,
        ctx: LocalContext,
      ) => void,
    ) {
      if (declaration.defined) throw Error("declareFunc: function is already defined");
      Object.assign(declaration, func<Args, Results, Locals>(ctx, signature, run));
    },
  });
}

// Ordered parameter tuples retain native argument types and arity.
type JSValues<T extends readonly ValueType[]> = {
  [i in keyof T]: JSValue<T[i]>;
};
type ReturnValues<T extends readonly ValueType[]> = T extends []
  ? void
  : T extends [ValueType]
    ? JSValue<T[0]>
    : JSValues<T>;

type JSFunction<T extends Dependency.AnyFunc> = (
  ...args: JSValues<T["type"]["args"]>
) => ReturnValues<T["type"]["results"]>;

type ToLocal<T extends Record<string, ValueType>> = {
  [K in keyof T]: Local<T[K]>;
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

/** An explicit function type must have the function's signature. */
function explicitType(definedType: DefinedType | undefined, signature: FunctionType) {
  if (definedType === undefined) return {};
  if (!isFunctionType(definedType.type) || !functionTypeEquals(definedType.type, signature))
    throw Error("func: the type does not match the signature");
  return { definedType };
}

/** Locals are grouped by type, which must compare by type equivalence, not by printed names. */
function sortLocals(locals: ValueType[], offset: number) {
  let types: ValueType[] = [];
  let count: number[] = [];
  let groups: number[] = [];
  let offsetWithin: number[] = [];
  for (let local of locals) {
    let i = types.findIndex((type) => typeEquals(type, local));
    if (i === -1) i = types.push(local) - 1;
    count[i] ??= 0;
    groups.push(i);
    offsetWithin.push(count[i]);
    count[i]++;
  }
  let typeOffset: number[] = Array(count.length).fill(0);
  for (let i = 1; i < count.length; i++) {
    typeOffset[i] = count[i - 1] + typeOffset[i - 1];
  }
  let localIndices = locals.map((_, j) => offset + typeOffset[groups[j]] + offsetWithin[j]);
  let sortedLocals: ValueType[] = types.flatMap((type, i) => Array(count[i]).fill(type));
  return { sortedLocals, localIndices };
}

// binable

const CompressedLocals = vec(tuple([U32, ValueType]));
const Locals = iso<[number, ValueType][], ValueType[]>(CompressedLocals, {
  // Runs of equal types, which keeps locals in order.
  to(locals) {
    let runs: [number, ValueType][] = [];
    for (let local of locals) {
      let last = runs.at(-1);
      if (last !== undefined && typeEquals(last[1], local)) last[0]++;
      else runs.push([1, local]);
    }
    return runs;
  },
  from(compressed) {
    let locals: ValueType[] = [];
    for (let [count, local] of compressed) {
      locals.push(...Array(count).fill(local));
    }
    return locals;
  },
});
