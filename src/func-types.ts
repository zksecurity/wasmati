import type {} from "./js-api.ts";
import type { Code } from "./code.ts";
import type * as Dependency from "./dependency.ts";
import type { Parameters, ParameterEntry } from "./parameters.ts";
import { ValueType } from "./types.ts";

export type { Func, ImportFunc, AnyFunc };

type Func<Args extends readonly ParameterEntry[], Results extends readonly ValueType[]> = {
  kind: "function";
  name?: string;
  localNames?: Record<number, string>;
  locals: ValueType[];
  code: Code;
  deps: Dependency.t[];
  /** Functions that the code calls directly. */
  calls: AnyFunc<any, any>[];
  params: Parameters<Args>;
  type: { args: Parameters<Args>["types"]; results: Results };
  defined: boolean;
};

type ImportFunc<Args extends readonly ParameterEntry[], Results extends readonly ValueType[]> = {
  module?: string;
  field?: string;
  kind: "importFunction";
  name?: string;
  params: Parameters<Args>;
  type: { args: Parameters<Args>["types"]; results: Results };
  value: Function;
  /** An async import, which suspends Wasm until its promise resolves (JSPI). */
  async?: true;
  deps: [];
};

type AnyFunc<Args extends readonly ParameterEntry[], Results extends readonly ValueType[]> =
  Func<Args, Results> | ImportFunc<Args, Results>;
