import { writeIndexed } from "../binable.ts";
import type * as Dependency from "../dependency.ts";
import { checkAllowed, define, emitInstruction } from "./base.ts";
import { GlobalIndex, LocalIndex, type Local } from "../types.ts";
import { type LocalContext, missingLocal, pushResult } from "../local-context.ts";

export { localGet, globalGet, globalGetInstruction, instructions };

const localGetInstruction = define("local.get", LocalIndex);

/** The value of a local, of its type in the function. Constant expressions have no locals. */
function localGet(ctx: LocalContext, x: Local) {
  let local = ctx.locals[x.index];
  if (local === undefined) throw missingLocal(ctx, x.index);
  writeIndexed(ctx.code, 0x20, x.index);
  return pushResult(ctx, local);
}

const globalGetInstruction = define("global.get", GlobalIndex, ([index]: number[]) => index);

/** The value of a global, whose index is a hole that Module() fills in. */
function globalGet(ctx: LocalContext, global: Dependency.AnyGlobal) {
  if (ctx.allowed !== undefined) checkAllowed(ctx, "global.get");
  emitInstruction(ctx, globalGetInstruction, [global], []);
  return pushResult(ctx, global.type.value);
}

/** The instructions of the functions above, which lookups by name or opcode find. */
const instructions = [localGetInstruction, globalGetInstruction];
