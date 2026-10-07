import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const index = fileURLToPath(new URL("../index.ts", import.meta.url));

/** The skill's examples that import wasmati, which must type-check and run. */
async function examples() {
  const skill = await readFile(join(root, "skills/wasmati/SKILL.md"), "utf8");
  return [...skill.matchAll(/```ts\n(import [\s\S]*?)```/g)].map(([, code]) =>
    code.replace(/from "wasmati";/g, `from ${JSON.stringify(index)};`),
  );
}

test("the skill's examples type-check and run", async () => {
  const sources = await examples();
  assert.ok(sources.length >= 10, "the skill has examples");
  const directory = await mkdtemp(join(tmpdir(), "wasmati-skill-"));
  try {
    const paths = await Promise.all(
      sources.map(async (source, i) => {
        const path = join(directory, `example${i}.mts`);
        await writeFile(path, source);
        return path;
      }),
    );
    const check = spawnSync(
      join(root, "node_modules/.bin/tsc"),
      [
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--target",
        "esnext",
        "--module",
        "nodenext",
        "--allowImportingTsExtensions",
        "--skipLibCheck",
        "--types",
        "node",
        "--typeRoots",
        join(root, "node_modules/@types"),
        ...paths,
      ],
      { encoding: "utf8", cwd: root },
    );
    assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
    for (const [i, path] of paths.entries()) {
      try {
        await import(pathToFileURL(path).href);
      } catch (error) {
        throw Error(`example ${i}:\n${sources[i]}`, { cause: error });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
