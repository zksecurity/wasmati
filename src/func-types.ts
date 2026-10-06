import type * as Dependency from "./dependency.ts";
import { ValueType } from "./types.ts";

export type { Func, ImportFunc, AnyFunc };

type Func<
  Args extends readonly ValueType[],
  Results extends readonly ValueType[]
> = {
  kind: "function";
  locals: ValueType[];
  body: Dependency.Instruction[];
  deps: Dependency.t[];
  type: { args: Args; results: Results };
};

type ImportFunc<
  Args extends readonly ValueType[],
  Results extends readonly ValueType[]
> = {
  module?: string;
  string?: string;
  kind: "importFunction";
  type: { args: Args; results: Results };
  value: Function;
  deps: [];
};

type AnyFunc<
  Args extends readonly ValueType[],
  Results extends readonly ValueType[]
> = Func<Args, Results> | ImportFunc<Args, Results>;
