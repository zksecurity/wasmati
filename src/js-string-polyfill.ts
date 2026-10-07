// JS functions that behave like the JS string builtins, for engines and bundlers without them.
// This module does not depend on wasmati: `wasmati build` copies it next to built modules.

/** Builtins trap where they get no string, or an index out of bounds. */
function trap(): never {
  throw new WebAssembly.RuntimeError("illegal argument to a JS string builtin");
}

function checkString(value: unknown): string {
  if (typeof value !== "string") trap();
  return value;
}

/**
 * JS cannot access Wasm arrays of UTF-16 code units, `(array (mut i16))`; a helper module reads and
 * writes them. These are its bytes, which a test builds with wasmati and compares.
 */
export const helperBytes =
  "AGFzbQEAAAABGARedwFgAWMAAX9gAmMAfwF/YANjAH9/AAMEAwECAwcWAwZsZW5ndGgAAANnZXQAAQNzZXQAAgwBAAoeAwYAIAD7DwsJACAAIAH7DQALCwAgACABIAL7DgALAEQEbmFtZQETAwAGbGVuZ3RoAQNnZXQCA3NldAIoAwABAAVhcnJheQECAAVhcnJheQEBaQIDAAVhcnJheQEBaQIEY29kZQ==";

type Arrays = {
  length(array: unknown): number;
  get(array: unknown, i: number): number;
  set(array: unknown, i: number, code: number): void;
};
let helper: Arrays | undefined;
function arrays(): Arrays {
  if (helper !== undefined) return helper;
  const bytes = Uint8Array.from(atob(helperBytes), (char) => char.charCodeAt(0));
  helper = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as unknown as Arrays;
  return helper;
}

export function test(value: unknown) {
  return typeof value === "string" ? 1 : 0;
}

export function cast(value: unknown) {
  return checkString(value);
}

export function fromCharCodeArray(array: unknown, start: number, end: number) {
  [start, end] = [start >>> 0, end >>> 0];
  const { length, get } = arrays();
  if (start > end || end > length(array)) trap();
  let result = "";
  for (let i = start; i < end; i++) result += String.fromCharCode(get(array, i));
  return result;
}

export function intoCharCodeArray(value: unknown, array: unknown, start: number) {
  const string = checkString(value);
  start >>>= 0;
  const { length, set } = arrays();
  if (start + string.length > length(array)) trap();
  for (let i = 0; i < string.length; i++) set(array, start + i, string.charCodeAt(i));
  return string.length;
}

export function fromCharCode(code: number) {
  return String.fromCharCode(code >>> 0);
}

export function fromCodePoint(code: number) {
  if (code >>> 0 > 0x10ffff) trap();
  return String.fromCodePoint(code >>> 0);
}

export function charCodeAt(value: unknown, index: number) {
  const string = checkString(value);
  if (index >>> 0 >= string.length) trap();
  return string.charCodeAt(index >>> 0);
}

export function codePointAt(value: unknown, index: number) {
  const string = checkString(value);
  if (index >>> 0 >= string.length) trap();
  return string.codePointAt(index >>> 0)!;
}

export function length(value: unknown) {
  return checkString(value).length;
}

export function concat(first: unknown, second: unknown) {
  return checkString(first) + checkString(second);
}

export function substring(value: unknown, start: number, end: number) {
  const string = checkString(value);
  [start, end] = [start >>> 0, end >>> 0];
  return start > end ? "" : string.substring(start, end);
}

export function equals(first: unknown, second: unknown) {
  if (first !== null) checkString(first);
  if (second !== null) checkString(second);
  return first === second ? 1 : 0;
}

export function compare(first: unknown, second: unknown) {
  const [a, b] = [checkString(first), checkString(second)];
  return a < b ? -1 : a === b ? 0 : 1;
}
