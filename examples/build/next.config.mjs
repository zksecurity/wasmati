export default {
  output: "export",
  distDir: "dist/next",
  // Bundlers lack JS string builtins: map their module to the polyfill that the build writes.
  turbopack: { resolveAlias: { "wasm:js-string": "./src/built/js-string.js" } },
};
