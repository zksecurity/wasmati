import type * as Dependency from "../dependency.ts";
import { baseInstruction } from "./base.ts";
import { GlobalIndex, LocalIndex, type Local } from "../types.ts";
import { type LocalContext, missingLocal, pushResult } from "../local-context.ts";

export { localGet, globalGet };

const localGetBase = baseInstruction("local.get", LocalIndex, {
  create(ctx, x: Local) {
    let local = ctx.locals[x.index];
    if (local === undefined) throw missingLocal(ctx, x.index);
    return { in: [], out: [local] };
  },
  resolve: (_, x: Local) => x.index,
});
const localGet = Object.assign(
  function (ctx: LocalContext, x: Local) {
    let local = ctx.locals[x.index];
    // Constant expressions have no locals.
    if (local === undefined) throw missingLocal(ctx, x.index);
    ctx.code.indexed(0x20, x.index);
    return pushResult(ctx, local);
  },
  { create: localGetBase.create, instruction: localGetBase.instruction },
);

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
