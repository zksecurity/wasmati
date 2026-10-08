import assert from "node:assert/strict";
import test from "node:test";
// Only the lookups, as in a bundle that leaves out the instruction API.
import { isInstruction, lookupInstruction, lookupOpcode } from "../instruction/all.ts";
import { nameToOpcode } from "../instruction/opcodes.ts";

test("every instruction is found by name and by opcode", () => {
  for (let [name, opcode] of Object.entries(nameToOpcode)) {
    assert.equal(lookupInstruction(name).string, name);
    let byOpcode = lookupOpcode(typeof opcode === "number" ? opcode : opcode[0]);
    let instruction = isInstruction(byOpcode)
      ? byOpcode
      : byOpcode[(opcode as [number, number])[1]];
    assert.equal(instruction?.string, name);
  }
});
