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

run("npx", "wasmati", "build", "src/counter.ts", "-o", "src/built");

// Node imports the built module directly.
const { increment } = await import("./src/built/counter.wasm");
increment(1);
check("Node", increment(41));

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
for (const bundler of ["vite", "webpack"]) {
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
    check(`Chrome with ${bundler}`, Number(dom.match(/<title>count (\d+)<\/title>/)?.[1]));
  } finally {
    server.close();
  }
}

function check(where: string, result: number) {
  if (result !== 42) throw Error(`${where}: expected count 42, got ${result}`);
  console.log(`${where}: count 42`);
}
