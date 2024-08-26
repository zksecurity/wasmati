import * as Dependency from "../dependency.js";
import { U32 } from "../immediate.js";
import { baseInstruction } from "./base.js";
import { Local } from "../types.js";

export { localGet, globalGet };

const localGet = baseInstruction("local.get", U32, {
  create({ locals }, x: Local) {
    let local = locals[x.index];
    if (local === undefined)
      throw Error(`local with index ${x.index} not available`);
    return { in: [], out: [local] };
  },
  resolve: (_, x: Local) => x.index,
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
