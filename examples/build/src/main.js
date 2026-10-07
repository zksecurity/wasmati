import { summary } from "./counter-page.js";
import { greet } from "./built/greet.wasm";

document.title = `${summary}, ${greet("wasmati")}`;
