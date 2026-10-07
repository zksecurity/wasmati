// Builds the example with `wasmati build`, runs it in Node, bundles it with Vite and with Next.js
// (Turbopack), and loads each bundle in headless Chrome. Set CHROME to the browser binary (default:
// google-chrome).
import { execFile, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { Module as WasmatiModule } from "wasmati";

const root = fileURLToPath(new URL(".", import.meta.url));
const run = (command: string, ...args: string[]) =>
  execFileSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
const expected = "count 42, hello wasmati";

run("npm", "run", "build");

// Node imports the built module directly.
const { increment, greet } = await import("./src/built/counter.wasm");
increment(1);
check("Node", `count ${increment(41)}, ${greet("wasmati")}`);

// wasmati has no side effects: bundles keep only the code they use, and all instructions they decode.
for (const entry of ["unused", "builder", "decode"])
  await build({
    configFile: false,
    logLevel: "silent",
    build: {
      target: "esnext",
      outDir: `dist/shake/${entry}`,
      lib: { entry: join(root, "shake", `${entry}.js`), formats: ["es"], fileName: entry },
    },
  });
const unused = await stat(join(root, "dist/shake/unused/unused.js"));
if (unused.size > 1000) throw Error(`an unused import of wasmati bundles to ${unused.size} bytes`);
console.log(`Vite without wasmati: ${unused.size} bytes`);
const { add2 } = await import("./dist/shake/builder/builder.js");
if ((await add2()) !== 2) throw Error("the bundled builder computes 1 + 1 wrong");
console.log("Vite with the builder only: 1 + 1 = 2");
const { names } = await import("./dist/shake/decode/decode.js");
const wat = `(module (memory 1) (type $p (struct (field i32)))
  (func (param i32) (result i32)
    (block (result i32) (i32.add (local.get 0) (i32.load offset=4 (i32.const 0))))
    (drop (struct.new $p (i32.const 1)))
    (i64.add (i64.const 1) (i64.const 2)) (drop)))`;
const decoded = names(WasmatiModule.fromWat(wat).toBytes()).join(" ");
if (decoded !== "block i32.const struct.new drop i64.const i64.const i64.add drop")
  throw Error(`the bundled decoder decodes ${decoded}`);
console.log(`Vite with the decoder only: ${decoded}`);

run("npx", "vite", "build");
run("npx", "next", "build");

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
};
for (const [bundler, directory] of [
  ["Vite", "dist/vite"],
  ["Next.js", "dist/next"],
]) {
  const server = createServer(async (request, response) => {
    const path = join(root, directory, new URL(request.url!, "http://localhost").pathname);
    const file = (await stat(path).catch(() => undefined))?.isDirectory()
      ? join(path, "index.html")
      : path;
    if (!(await stat(file).catch(() => undefined))) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    // Wasm compiles asynchronously, so the page may not be done when Chrome dumps it: wait longer.
    let title: string | undefined;
    for (const budget of [5000, 15000, 30000]) {
      title = (await dumpDom(`http://127.0.0.1:${port}/`, budget)).match(
        /<title>(.*?)<\/title>/,
      )?.[1];
      if (title === expected) break;
    }
    check(`Chrome with ${bundler}`, title);
  } finally {
    server.close();
  }
}

function dumpDom(url: string, budget: number) {
  const chrome = process.env.CHROME ?? "google-chrome";
  const args = ["--headless", "--no-sandbox", `--virtual-time-budget=${budget}`, "--dump-dom", url];
  return new Promise<string>((resolve, reject) =>
    execFile(chrome, args, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );
}

function check(where: string, result: string | undefined) {
  if (result !== expected) throw Error(`${where}: expected "${expected}", got "${result}"`);
  console.log(`${where}: ${expected}`);
}
