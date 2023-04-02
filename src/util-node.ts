import fs from "node:fs/promises";

export { writeFile };

async function writeFile(fileName: string, content: string | Uint8Array) {
  if (typeof content === "string") {
    await fs.writeFile(fileName, content, "utf8");
  } else {
    await fs.writeFile(fileName, content);
  }
  console.log(`wrote ${(content.length / 1e3).toFixed(1)}kB to ${fileName}`);
}
