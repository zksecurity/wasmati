import { importFunc, importGlobal } from "./export.ts";
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
const string = refType("extern", false);
const charCodes = refType(charCodeArray, true);

/** Builtins on arrays cannot be emulated in JS, which cannot access Wasm arrays. */
function unavailable(): never {
  throw Error("this JS string builtin requires an engine with JS string builtins");
}

/**
 * JS string builtins: functions on JS strings as `externref`, provided by the engine. Without engine
 * support, JS functions emulate the builtins that do not access arrays.
 */
const jsString = {
  charCodeArray,
  test: importFunc(
    { module: builtinModule, field: "test", in: [{ value: externref }], out: [i32] },
    (value) => (typeof value === "string" ? 1 : 0),
  ),
  cast: importFunc(
    { module: builtinModule, field: "cast", in: [{ value: externref }], out: [{ kind: string }] },
    (value) => {
      if (typeof value !== "string") throw new WebAssembly.RuntimeError("not a string");
      return value;
    },
  ),
  fromCharCodeArray: importFunc(
    {
      module: builtinModule,
      field: "fromCharCodeArray",
      in: [{ array: { kind: charCodes } }, { start: i32 }, { end: i32 }],
      out: [{ kind: string }],
    },
    unavailable,
  ),
  intoCharCodeArray: importFunc(
    {
      module: builtinModule,
      field: "intoCharCodeArray",
      in: [{ string: externref }, { array: { kind: charCodes } }, { start: i32 }],
      out: [i32],
    },
    unavailable,
  ),
  fromCharCode: importFunc(
    { module: builtinModule, field: "fromCharCode", in: [{ code: i32 }], out: [{ kind: string }] },
    (code) => String.fromCharCode(code),
  ),
  fromCodePoint: importFunc(
    { module: builtinModule, field: "fromCodePoint", in: [{ code: i32 }], out: [{ kind: string }] },
    (code) => String.fromCodePoint(code >>> 0),
  ),
  charCodeAt: importFunc(
    {
      module: builtinModule,
      field: "charCodeAt",
      in: [{ string: externref }, { index: i32 }],
      out: [i32],
    },
    (string, index) => (string as string).charCodeAt(index >>> 0),
  ),
  codePointAt: importFunc(
    {
      module: builtinModule,
      field: "codePointAt",
      in: [{ string: externref }, { index: i32 }],
      out: [i32],
    },
    (string, index) => (string as string).codePointAt(index >>> 0)!,
  ),
  length: importFunc(
    { module: builtinModule, field: "length", in: [{ string: externref }], out: [i32] },
    (string) => (string as string).length,
  ),
  concat: importFunc(
    {
      module: builtinModule,
      field: "concat",
      in: [{ first: externref }, { second: externref }],
      out: [{ kind: string }],
    },
    (first, second) => (first as string) + (second as string),
  ),
  substring: importFunc(
    {
      module: builtinModule,
      field: "substring",
      in: [{ string: externref }, { start: i32 }, { end: i32 }],
      out: [{ kind: string }],
    },
    (string, start, end) => (string as string).substring(start >>> 0, end >>> 0),
  ),
  equals: importFunc(
    {
      module: builtinModule,
      field: "equals",
      in: [{ first: externref }, { second: externref }],
      out: [i32],
    },
    (first, second) => (first === second ? 1 : 0),
  ),
  compare: importFunc(
    {
      module: builtinModule,
      field: "compare",
      in: [{ first: externref }, { second: externref }],
      out: [i32],
    },
    (first, second) => ((first as string) < (second as string) ? -1 : first === second ? 0 : 1),
  ),
};

/** A JS string constant, imported as an immutable `externref` global. */
function stringConstant(value: string) {
  return importGlobal(externref, value, { module: constantModule, field: value });
}
