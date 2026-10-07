// Builds the example with `wasmati build`, runs it in Node, bundles it with Vite and webpack, and loads
// each bundle in headless Chrome. Set CHROME to the browser binary (default: google-chrome).
import { execFile, execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const run = (command: string, ...args: string[]) =>
  execFileSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"] }).toString();

run("npm", "run", "build");

// Node imports the built modules directly.
const { increment, measure } = await import("./src/built/counter.wasm");
const { greet } = await import("./src/built/greet.wasm");
increment(1);
const all = "count 42, length 7, hello wasmati";
check("Node", `count ${increment(41)}, length ${measure("wasmati")}, ${greet("wasmati")}`, all);

run("npx", "vite", "build");
run("npx", "webpack");
const html = (await readFile(join(root, "index.html"), "utf8")).replace(
  "./src/main.js",
  "./main.js",
);
await writeFile(join(root, "dist/webpack/index.html"), html.replace('type="module" ', ""));

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};
// webpack cannot parse Wasm 3.0 types, so its page only uses the counter.
const expected = { vite: all, webpack: "count 42, length 7" };
for (const bundler of ["vite", "webpack"] as const) {
  const directory = join(root, "dist", bundler);
  const server = createServer(async (request, response) => {
    const path = join(directory, new URL(request.url!, "http://localhost").pathname);
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
    check(`Chrome with ${bundler}`, dom.match(/<title>(.*)<\/title>/)?.[1], expected[bundler]);
  } finally {
    server.close();
  }
}

function check(where: string, result: string | undefined, expected: string) {
  if (result !== expected) throw Error(`${where}: expected "${expected}", got "${result}"`);
  console.log(`${where}: ${expected}`);
}
