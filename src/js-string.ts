import { importFunc, importGlobal } from "./export.ts";
import { array as arrayOps, func, Module } from "./index.ts";
import { array, i16, mut } from "./type-definitions.ts";
import { externref, i32t as i32, refType } from "./types.ts";

export { jsString, stringConstant, jsStringBuiltins, usesJSStringBuiltins };

/** The import modules of JS string builtins and of imported string constants. */
const builtinModule = "wasm:js-string";
const constantModule = "'";

/** Instantiation options that enable JS string builtins and imported string constants. */
const jsStringBuiltins = { builtins: ["js-string"], importedStringConstants: constantModule };

function usesJSStringBuiltins(imports: { module: string }[]) {
  return imports.some(({ module }) => module === builtinModule || module === constantModule);
}

/** The array type that builtins read characters from and write them to: UTF-16 code units. */
const charCodeArray = array(mut(i16));
const string = { kind: refType("extern", false) };
const charCodes = { kind: refType(charCodeArray, true) };

/** The import path of a builtin. */
function builtin(name: string) {
  return { module: builtinModule, field: name };
}

/**
 * JS string builtins: functions on JS strings as `externref`, provided by the engine. Without engine
 * support, the imports' JS functions behave the same.
 */
const jsString = {
  charCodeArray,
  test: importFunc({ ...builtin("test"), in: [{ value: externref }], out: [i32] }, (value) =>
    typeof value === "string" ? 1 : 0,
  ),
  cast: importFunc({ ...builtin("cast"), in: [{ value: externref }], out: [string] }, (value) =>
    checkString(value),
  ),
  fromCharCodeArray: importFunc(
    {
      ...builtin("fromCharCodeArray"),
      in: [{ array: charCodes }, { start: i32 }, { end: i32 }],
      out: [string],
    },
    (array, start, end) => {
      [start, end] = [start >>> 0, end >>> 0];
      let { length, get } = arrays();
      if (start > end || end > length(array)) trap();
      let result = "";
      for (let i = start; i < end; i++) result += String.fromCharCode(get(array, i));
      return result;
    },
  ),
  intoCharCodeArray: importFunc(
    {
      ...builtin("intoCharCodeArray"),
      in: [{ string: externref }, { array: charCodes }, { start: i32 }],
      out: [i32],
    },
    (value, array, start) => {
      let string = checkString(value);
      start >>>= 0;
      let { length, set } = arrays();
      if (start + string.length > length(array)) trap();
      for (let i = 0; i < string.length; i++) set(array, start + i, string.charCodeAt(i));
      return string.length;
    },
  ),
  fromCharCode: importFunc(
    { ...builtin("fromCharCode"), in: [{ code: i32 }], out: [string] },
    (code) => String.fromCharCode(code >>> 0),
  ),
  fromCodePoint: importFunc(
    { ...builtin("fromCodePoint"), in: [{ code: i32 }], out: [string] },
    (code) => {
      if (code >>> 0 > 0x10ffff) trap();
      return String.fromCodePoint(code >>> 0);
    },
  ),
  charCodeAt: importFunc(
    { ...builtin("charCodeAt"), in: [{ string: externref }, { index: i32 }], out: [i32] },
    (value, index) => {
      let string = checkString(value);
      if (index >>> 0 >= string.length) trap();
      return string.charCodeAt(index >>> 0);
    },
  ),
  codePointAt: importFunc(
    { ...builtin("codePointAt"), in: [{ string: externref }, { index: i32 }], out: [i32] },
    (value, index) => {
      let string = checkString(value);
      if (index >>> 0 >= string.length) trap();
      return string.codePointAt(index >>> 0)!;
    },
  ),
  length: importFunc(
    { ...builtin("length"), in: [{ string: externref }], out: [i32] },
    (value) => checkString(value).length,
  ),
  concat: importFunc(
    { ...builtin("concat"), in: [{ first: externref }, { second: externref }], out: [string] },
    (first, second) => checkString(first) + checkString(second),
  ),
  substring: importFunc(
    {
      ...builtin("substring"),
      in: [{ string: externref }, { start: i32 }, { end: i32 }],
      out: [string],
    },
    (value, start, end) => {
      let string = checkString(value);
      [start, end] = [start >>> 0, end >>> 0];
      return start > end ? "" : string.substring(start, end);
    },
  ),
  equals: importFunc(
    { ...builtin("equals"), in: [{ first: externref }, { second: externref }], out: [i32] },
    (first, second) => {
      if (first !== null) checkString(first);
      if (second !== null) checkString(second);
      return first === second ? 1 : 0;
    },
  ),
  compare: importFunc(
    { ...builtin("compare"), in: [{ first: externref }, { second: externref }], out: [i32] },
    (first, second) => {
      let [a, b] = [checkString(first), checkString(second)];
      return a < b ? -1 : a === b ? 0 : 1;
    },
  ),
};

/** Builtins trap where they get no string, or an index out of bounds. */
function trap(): never {
  throw new WebAssembly.RuntimeError("illegal argument to a JS string builtin");
}

function checkString(value: unknown): string {
  if (typeof value !== "string") trap();
  return value;
}

/** JS cannot access Wasm arrays; a helper module, built once, reads and writes them. */
let helper:
  | {
      length(array: unknown): number;
      get(array: unknown, i: number): number;
      set(array: unknown, i: number, code: number): void;
    }
  | undefined;
function arrays() {
  if (helper !== undefined) return helper;
  let length = func({ in: [{ array: charCodes }], out: [i32] }, ({ array }) => arrayOps.len(array));
  let get = func({ in: [{ array: charCodes }, { i: i32 }], out: [i32] }, ({ array, i }) =>
    arrayOps.get_u(charCodeArray, array, i),
  );
  let set = func(
    { in: [{ array: charCodes }, { i: i32 }, { code: i32 }], out: [] },
    ({ array, i, code }) => arrayOps.set(charCodeArray, array, i, code),
  );
  let bytes = Module({ exports: { length, get, set } }).toBytes();
  helper = new WebAssembly.Instance(new WebAssembly.Module(bytes))
    .exports as unknown as typeof helper;
  return helper!;
}

/** A JS string constant, imported as an immutable `externref` global. */
function stringConstant(value: string) {
  return importGlobal(externref, value, { module: constantModule, field: value });
}
