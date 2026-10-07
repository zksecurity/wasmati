// Imports the built Wasm module directly, as an ES module.
import { increment, measure } from "./built/counter.wasm";

increment(1);
export const summary = `count ${increment(41)}, length ${measure("wasmati")}`;
document.title = summary;
