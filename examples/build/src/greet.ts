import { Module, func, global, call, externref, jsString, stringConstant } from "wasmati";

// Uses Wasm 3.0 types: concat returns a non-null reference, (ref extern), which webpack cannot parse.
const hello = stringConstant("hello ");
const greet = func({ in: [{ name: externref }], out: [externref] }, ({ name }) => {
  call(jsString.concat, { first: global.get(hello), second: name });
});

export default Module({ exports: { greet } });
