import { parentPort, workerData } from "node:worker_threads";
import type { List } from "../text/lexer.ts";
import { type Instance, runCommands, type SharedInstance } from "./wast-runner.ts";

// A WAST thread: its commands run with the shared instances, which provide their shared memories.
const { source, commands, shared } = workerData as {
  source: string;
  commands: List[];
  shared: [string, SharedInstance][];
};
const instances = new Map(
  shared.map(([name, { exports, module }]): [string, Instance] => [
    name,
    { instance: { exports } as WebAssembly.Instance, module },
  ]),
);
parentPort!.postMessage(await runCommands(source, commands, instances));
