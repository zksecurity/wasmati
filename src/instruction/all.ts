import * as atomic from "./atomic.ts";
import { type BaseInstruction, isInstruction } from "./base.ts";
import * as constants from "./const.ts";
import * as control from "./control.ts";
import * as gc from "./gc.ts";
import * as memory from "./memory.ts";
import * as numeric from "./numeric.ts";
import * as variable from "./variable.ts";
import * as variableGet from "./variable-get.ts";
import * as vector from "./vector.ts";

export { lookupInstruction, lookupOpcode, lookupSubcode, isInstruction };

/** The modules that define instructions, whose exports are where lookups find them. */
const modules = [atomic, constants, control, gc, memory, numeric, variable, variableGet, vector];

type Tables = {
  names: Record<string, BaseInstruction>;
  opcodes: Record<number, BaseInstruction | Record<number, BaseInstruction>>;
};
let tables: Tables | undefined;

/**
 * Instructions by name and by opcode, collected from the exports of the modules that define them,
 * which are instructions themselves or carry them as `instruction`.
 */
function instructionTables(): Tables {
  if (tables !== undefined) return tables;
  let names: Tables["names"] = {};
  let opcodes: Tables["opcodes"] = {};
  let seen = new Set<object>();
  let visit = (value: unknown) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (isBaseInstruction(value)) {
      names[value.string] = value;
      let { opcode } = value;
      if (typeof opcode === "number") opcodes[opcode] = value;
      else ((opcodes[opcode[0]] ??= {}) as Record<number, BaseInstruction>)[opcode[1]] = value;
      return;
    }
    for (let key of Object.keys(value)) visit((value as Record<string, unknown>)[key]);
  };
  for (let module of modules) visit(module);
  return (tables = { names, opcodes });
}

function isBaseInstruction(value: object): value is BaseInstruction {
  return "opcodeBytes" in value && "resolve" in value;
}

function lookupInstruction(name: string) {
  let instr = instructionTables().names[name];
  if (instr === undefined) throw Error(`invalid instruction name "${name}"`);
  return instr;
}

function lookupOpcode(opcode: number) {
  let instr = instructionTables().opcodes[opcode];
  if (instr === undefined) throw Error(`invalid opcode "${opcode}"`);
  return instr;
}

function lookupSubcode(opcode: number, subcode: number, codes: Record<number, BaseInstruction>) {
  let instr = codes[subcode];
  if (instr === undefined) throw Error(`invalid opcode (${opcode}, ${subcode})`);
  return instr;
}
