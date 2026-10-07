import { fileURLToPath } from "node:url";

export default {
  mode: "production",
  entry: "./src/main.js",
  output: { path: fileURLToPath(new URL("./dist/webpack", import.meta.url)) },
  experiments: { asyncWebAssembly: true },
};
