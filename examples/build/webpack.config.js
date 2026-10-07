import { fileURLToPath } from "node:url";
import webpack from "webpack";

export default {
  mode: "production",
  entry: "./src/counter-page.js",
  output: { path: fileURLToPath(new URL("./dist/webpack", import.meta.url)) },
  experiments: { asyncWebAssembly: true },
  plugins: [
    // Bundlers lack JS string builtins: map their module to the polyfill that the build writes.
    new webpack.NormalModuleReplacementPlugin(
      /^wasm:js-string$/,
      fileURLToPath(new URL("./src/built/js-string.js", import.meta.url)),
    ),
  ],
};
