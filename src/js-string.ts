import { importFunc, importGlobal } from "./export.ts";
import * as polyfill from "./js-string-polyfill.ts";
import { array, i16, mut } from "./type-definitions.ts";
import { externref, i32t as i32, refType } from "./types.ts";

export {
  jsString,
  stringConstant,
  jsStringBuiltins,
  usesJSStringBuiltins,
  builtinModule,
  constantModule,
};

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
 * support, the imports' JS functions, from the polyfill, behave the same.
 */
const jsString = {
  charCodeArray,
  test: importFunc({ ...builtin("test"), in: [{ value: externref }], out: [i32] }, polyfill.test),
  cast: importFunc(
    { ...builtin("cast"), in: [{ value: externref }], out: [string] },
    polyfill.cast,
  ),
  fromCharCodeArray: importFunc(
    {
      ...builtin("fromCharCodeArray"),
      in: [{ array: charCodes }, { start: i32 }, { end: i32 }],
      out: [string],
    },
    polyfill.fromCharCodeArray,
  ),
  intoCharCodeArray: importFunc(
    {
      ...builtin("intoCharCodeArray"),
      in: [{ string: externref }, { array: charCodes }, { start: i32 }],
      out: [i32],
    },
    polyfill.intoCharCodeArray,
  ),
  fromCharCode: importFunc(
    { ...builtin("fromCharCode"), in: [{ code: i32 }], out: [string] },
    polyfill.fromCharCode,
  ),
  fromCodePoint: importFunc(
    { ...builtin("fromCodePoint"), in: [{ code: i32 }], out: [string] },
    polyfill.fromCodePoint,
  ),
  charCodeAt: importFunc(
    { ...builtin("charCodeAt"), in: [{ string: externref }, { index: i32 }], out: [i32] },
    polyfill.charCodeAt,
  ),
  codePointAt: importFunc(
    { ...builtin("codePointAt"), in: [{ string: externref }, { index: i32 }], out: [i32] },
    polyfill.codePointAt,
  ),
  length: importFunc(
    { ...builtin("length"), in: [{ string: externref }], out: [i32] },
    polyfill.length,
  ),
  concat: importFunc(
    { ...builtin("concat"), in: [{ first: externref }, { second: externref }], out: [string] },
    polyfill.concat,
  ),
  substring: importFunc(
    {
      ...builtin("substring"),
      in: [{ string: externref }, { start: i32 }, { end: i32 }],
      out: [string],
    },
    polyfill.substring,
  ),
  equals: importFunc(
    { ...builtin("equals"), in: [{ first: externref }, { second: externref }], out: [i32] },
    polyfill.equals,
  ),
  compare: importFunc(
    { ...builtin("compare"), in: [{ first: externref }, { second: externref }], out: [i32] },
    polyfill.compare,
  ),
};

/** A JS string constant, imported as an immutable `externref` global. */
function stringConstant(value: string) {
  return importGlobal(externref, value, { module: constantModule, field: value });
}
