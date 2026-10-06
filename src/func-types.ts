import type * as Dependency from "./dependency.ts";
import type { Parameters } from "./parameters.ts";
import { ValueType } from "./types.ts";

export type { Func, ImportFunc, AnyFunc };

type Func<Args extends Parameters, Results extends readonly ValueType[]> = {
  kind: "function";
  name?: string;
  localNames?: Record<number, string>;
  locals: ValueType[];
  body: Dependency.Instruction[];
  deps: Dependency.t[];
  params: Args;
  type: { args: Args["types"]; results: Results };
};

type ImportFunc<Args extends Parameters, Results extends readonly ValueType[]> = {
  module?: string;
  string?: string;
  kind: "importFunction";
  name?: string;
  params: Args;
  type: { args: Args["types"]; results: Results };
  value: Function;
  deps: [];
};

type AnyFunc<Args extends Parameters, Results extends readonly ValueType[]> =
  Func<Args, Results> | ImportFunc<Args, Results>;
