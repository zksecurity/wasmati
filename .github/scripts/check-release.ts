import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

const before = process.env.BEFORE_SHA;
const output = process.env.GITHUB_OUTPUT;
if (!before || !output) throw Error("BEFORE_SHA and GITHUB_OUTPUT are required");

const { name, version } = JSON.parse(await readFile("package.json", "utf8"));
const previous = JSON.parse(
  execFileSync("git", ["show", `${before}:package.json`], {
    encoding: "utf8",
  }),
);

let publish = false;
if (version === previous.version) {
  console.log(`Version remains ${version}; nothing to publish.`);
} else {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
  );
  if (response.status === 200) {
    console.log(`${name}@${version} is already published; skipping this run.`);
  } else if (response.status === 404) {
    publish = true;
    console.log(`Publish ${name}@${version} (previous version: ${previous.version}).`);
  } else {
    throw Error(`npm registry returned ${response.status} while checking ${name}@${version}`);
  }
}

// Prereleases should not replace the stable latest tag.
const tag = version.includes("-") ? "next" : "latest";
await appendFile(output, `publish=${publish}\ntag=${tag}\n`);
