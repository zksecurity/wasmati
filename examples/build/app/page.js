"use client";
import { useEffect } from "react";

export default function Page() {
  useEffect(() => {
    // Import the built Wasm module in client code, which the browser runs.
    import("../src/built/counter.wasm").then(({ increment, greet }) => {
      increment(1);
      document.title = `count ${increment(41)}, ${greet("wasmati")}`;
    });
  }, []);
  return null;
}
