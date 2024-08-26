import * as Dependency from "../dependency.js";
import { U32 } from "../immediate.js";
import { baseInstruction } from "./base.js";
import { Local, ValueType } from "../types.js";

export { localGet, globalGet };

type AnyLocal = Local<ValueType>;

const localGet = baseInstruction("local.get", U32, {
  create({ locals }, x: AnyLocal) {
    let local = locals[x.index];
    if (local === undefined)
      throw Error(`local with index ${x.index} not available`);
    return { in: [], out: [local] };
  },
  resolve: (_, x: AnyLocal) => x.index,
});

const globalGet = baseInstruction("global.get", U32, {
  create(_, global: Dependency.AnyGlobal) {
    return {
      in: [],
      out: [global.type.value],
      deps: [global],
    };
  },
  resolve: ([globalIdx]) => globalIdx,
});
