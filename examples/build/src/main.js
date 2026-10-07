// Imports the built Wasm module directly, as an ES module.
import { increment } from "./built/counter.wasm";

increment(1);
const result = increment(41);
document.title = `count ${result}`;
document.body.textContent = `count is ${result}`;
