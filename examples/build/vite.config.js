import { fileURLToPath } from "node:url";
import wasm from "vite-plugin-wasm";

export default {
  plugins: [wasm()],
  // Bundlers lack JS string builtins: map their module to the polyfill that the build writes.
  resolve: {
    alias: {
      "wasm:js-string": fileURLToPath(new URL("./src/built/js-string.js", import.meta.url)),
    },
  },
  // Built Wasm modules are imported with top-level await.
  build: { target: "esnext", outDir: "dist/vite" },
};
