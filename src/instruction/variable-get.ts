import type * as Dependency from "../dependency.ts";
import { baseInstruction, emitSimple } from "./base.ts";
import { GlobalIndex, LocalIndex, type Local, type ValueType } from "../types.ts";
import type { LocalContext } from "../local-context.ts";

export { localGet, globalGet };

const localGetBase = baseInstruction("local.get", LocalIndex, {
  create({ locals }, x: Local) {
    let local = locals[x.index];
    if (local === undefined) throw Error(`local with index ${x.index} not available`);
    return { in: [], out: [local] };
  },
  resolve: (_, x: Local) => x.index,
});
const localGet = Object.assign(
  function (ctx: LocalContext, x: Local) {
    let local = ctx.locals[x.index];
    if (local === undefined) throw Error(`local with index ${x.index} not available`);
    return emitSimple(ctx, localGetBase.instruction, noArgs, local, x.index)!;
  },
  { create: localGetBase.create, instruction: localGetBase.instruction },
);
const noArgs: ValueType[] = [];

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
