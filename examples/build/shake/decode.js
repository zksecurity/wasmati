// Decodes a module, which needs the instructions without the builder.
import { Module } from "wasmati";
export const names = (bytes) =>
  Module.fromBytes(bytes).module.funcs[0].body.map(({ name }) => name);
