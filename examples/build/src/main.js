// Imports the built Wasm module directly, as an ES module.
import { increment, greet } from "./built/counter.wasm";

increment(1);
document.title = `count ${increment(41)}, ${greet("wasmati")}`;
