import type * as Dependency from "../dependency.ts";
import { baseInstruction } from "./base.ts";
import { GlobalIndex, LocalIndex, type Local } from "../types.ts";

export { localGet, globalGet };

const localGet = baseInstruction("local.get", LocalIndex, {
  create({ locals }, x: Local) {
    let local = locals[x.index];
    if (local === undefined) throw Error(`local with index ${x.index} not available`);
    return { in: [], out: [local] };
  },
  resolve: (_, x: Local) => x.index,
});

const globalGet = baseInstruction("global.get", GlobalIndex, {
  create(_, global: Dependency.AnyGlobal) {
    return {
      in: [],
      out: [global.type.value],
      deps: [global],
    };
  },
  resolve: ([globalIdx]) => globalIdx,
});
