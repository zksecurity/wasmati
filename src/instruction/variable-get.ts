import type * as Dependency from "../dependency.ts";
import { baseInstruction, emitSimple } from "./base.ts";
import { GlobalIndex, LocalIndex, type Local, type ValueType } from "../types.ts";
import { type LocalContext, missingLocal, StackValue } from "../local-context.ts";

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
    if (local === undefined) throw missingLocal(ctx, x.index);
    if (ctx.allowed !== undefined)
      return emitSimple(ctx, localGetBase.instruction, noArgs, local, x.index)!;
    ctx.code.indexed(0x20, x.index);
    let value = new StackValue(local);
    ctx.stack.push(value);
    return value;
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
