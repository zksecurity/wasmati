// JS API additions that TypeScript's lib does not declare yet.
export {};

declare global {
  namespace WebAssembly {
    /** JS Promise Integration: an import that suspends Wasm while its promise is pending. */
    class Suspending {
      constructor(run: Function);
    }
    /** JS Promise Integration: an export that returns a promise and may suspend. */
    function promising(run: Function): Function;
    /** JS Promise Integration: thrown when Wasm would suspend without a promising export. */
    class SuspendError extends Error {}
  }
}
