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

const root = fileURLToPath(new URL(".", import.meta.url));
const run = (command: string, ...args: string[]) =>
  execFileSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] });
const expected = "count 42, hello wasmati";

run("npm", "run", "build");

// Node imports the built module directly.
const { increment, greet } = await import("./src/built/counter.wasm");
increment(1);
check("Node", `count ${increment(41)}, ${greet("wasmati")}`);

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
    const chrome = process.env.CHROME ?? "google-chrome";
    const args = ["--headless", "--no-sandbox", "--virtual-time-budget=5000", "--dump-dom"];
    const dom = await new Promise<string>((resolve, reject) =>
      execFile(chrome, [...args, `http://127.0.0.1:${port}/`], (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      ),
    );
    check(`Chrome with ${bundler}`, dom.match(/<title>(.*?)<\/title>/)?.[1]);
  } finally {
    server.close();
  }
}

function check(where: string, result: string | undefined) {
  if (result !== expected) throw Error(`${where}: expected "${expected}", got "${result}"`);
  console.log(`${where}: ${expected}`);
}
