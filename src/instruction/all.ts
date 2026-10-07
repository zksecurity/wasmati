import * as atomic from "./atomic.ts";
import {
  type BaseInstruction,
  isInstruction,
  nameToInstruction,
  opcodeToInstruction,
} from "./base.ts";
import * as constants from "./const.ts";
import * as control from "./control.ts";
import * as gc from "./gc.ts";
import * as memory from "./memory.ts";
import * as numeric from "./numeric.ts";
import * as variable from "./variable.ts";
import * as variableGet from "./variable-get.ts";
import * as vector from "./vector.ts";

export { lookupInstruction, lookupOpcode, lookupSubcode, isInstruction };

/**
 * The modules that define instructions, which they register when they load. Lookups depend on them,
 * so that bundlers keep all of them where instructions are looked up by name or opcode.
 */
const modules = [atomic, constants, control, gc, memory, numeric, variable, variableGet, vector];
let loaded = 0;

function lookupInstruction(name: string) {
  loaded ||= modules.length;
  let instr = nameToInstruction[name];
  if (instr === undefined) throw Error(`invalid instruction name "${name}"`);
  return instr;
}

function lookupOpcode(opcode: number) {
  loaded ||= modules.length;
  let instr = opcodeToInstruction[opcode];
  if (instr === undefined) throw Error(`invalid opcode "${opcode}"`);
  return instr;
}

function lookupSubcode(opcode: number, subcode: number, codes: Record<number, BaseInstruction>) {
  let instr = codes[subcode];
  if (instr === undefined) throw Error(`invalid opcode (${opcode}, ${subcode})`);
  return instr;
}
