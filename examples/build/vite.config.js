import wasm from "vite-plugin-wasm";

export default {
  plugins: [wasm()],
  // Built Wasm modules are imported with top-level await.
  build: { target: "esnext", outDir: "dist/vite" },
};
