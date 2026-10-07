import type {} from "./js-api.ts";
import type * as Dependency from "./dependency.ts";
import type { Parameters, ParameterEntry } from "./parameters.ts";
import { ValueType } from "./types.ts";

export type { Func, ImportFunc, AnyFunc };

type Func<Args extends readonly ParameterEntry[], Results extends readonly ValueType[]> = {
  kind: "function";
  name?: string;
  localNames?: Record<number, string>;
  locals: ValueType[];
  body: Dependency.Instruction[];
  deps: Dependency.t[];
  params: Parameters<Args>;
  type: { args: Parameters<Args>["types"]; results: Results };
  defined: boolean;
  promising?: true;
};

type ImportFunc<Args extends readonly ParameterEntry[], Results extends readonly ValueType[]> = {
  module?: string;
  field?: string;
  kind: "importFunction";
  name?: string;
  params: Parameters<Args>;
  type: { args: Parameters<Args>["types"]; results: Results };
  value: Function | WebAssembly.Suspending;
  deps: [];
};

type AnyFunc<Args extends readonly ParameterEntry[], Results extends readonly ValueType[]> =
  Func<Args, Results> | ImportFunc<Args, Results>;
