import assert from "node:assert/strict";
import { buildTextModule, loadTextFactory } from "./text-helpers.ts";
import { Script, Bytes, type Expression } from "../text/text.ts";
import { Command, type ActionValue } from "../text/script.ts";
import { head, position, token } from "../text/grammar.ts";
import { ModuleSyntax, Wat } from "../text/module.ts";
import { TextSyntaxError } from "../text/lexer.ts";
import { UnsupportedTextError } from "../text/lexer.ts";
import type { Module } from "../module-binable.ts";

export { runWast };
export type { Result };

type Result = {
  passed: number;
  failures: { command: number; line: number; kind: string; message: string }[];
};

function readModule(node: Expression): Module {
  if (!Array.isArray(node)) throw new TextSyntaxError("expected module");
  const start = !Array.isArray(node[1]) && node[1]?.kind === "identifier" ? 2 : 1;
  const encoding = !Array.isArray(node[start]) ? node[start]?.text : undefined;
  if (encoding === "binary")
    throw new UnsupportedTextError("binary WAST modules are not implemented");
  if (encoding !== "quote") return ModuleSyntax.decode([node], 0)[0];
  const data = node
    .slice(start + 1)
    .flatMap((expression) => token(Bytes).decode([expression], 0)[0]);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Uint8Array.from(data),
  );
  return Wat.fromText(text);
}

/** Execute each script command independently, reporting failures without skipping unsupported commands. */
async function runWast(source: string, imports: WebAssembly.Imports = {}): Promise<Result> {
  const expressions = Script.fromText(source);
  const result: Result = { passed: 0, failures: [] };
  const modules = new Map<string, WebAssembly.Instance>();
  const registered: WebAssembly.Imports = { ...imports };
  let current: WebAssembly.Instance | undefined;
  function instance(name: string | undefined): WebAssembly.Instance {
    const found = name === undefined ? current : modules.get(name);
    if (found === undefined) throw Error(`no module instance ${name ?? "<current>"}`);
    return found;
  }
  function action(action: ActionValue): unknown[] {
    const target = instance(action.module).exports[action.field];
    if (action.kind === "get") {
      assert.ok(target instanceof WebAssembly.Global, `${action.field} is not a global`);
      return [target.value];
    }
    assert.equal(typeof target, "function", `${action.field} is not a function`);
    const value = (target as Function)(...action.args.map((arg) => arg.value));
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  }
  for (const [index, expression] of expressions.entries()) {
    const kind = head(expression) ?? "<token>";
    try {
      // Quoted module commands must be decoded before the normal module grammar is selected.
      if (kind === "module") {
        current = undefined;
        const module = readModule(expression);
        const rebuilt = await buildTextModule(module, registered);
        current = (await rebuilt.instantiate()).instance;
        if (module.names?.module !== undefined) modules.set(module.names.module, current);
      } else {
        const [command] = Command.decode([expression], 0);
        switch (command.kind) {
          case "module":
            throw Error("module command dispatch failed");
          case "register":
            registered[command.name] = instance(command.module).exports;
            break;
          case "invoke":
          case "get":
            action(command);
            break;
          case "assert_return":
            assert.deepEqual(
              action(command.action),
              command.expected.map((value) => value.value),
            );
            break;
          case "assert_trap": {
            const messages: Record<string, RegExp> = {
              "integer divide by zero": /(divide|remainder) by zero/i,
              "integer overflow": /overflow|unrepresentable/i,
              unreachable: /unreachable/i,
            };
            assert.throws(
              () => action(command.action),
              (error) =>
                error instanceof WebAssembly.RuntimeError &&
                (messages[command.message]?.test(error.message) ??
                  error.message.includes(command.message)),
            );
            break;
          }
          case "assert_invalid": {
            const module = readModule(command.module);
            // Parsing, emission and loading are prerequisites, not evidence of invalidity.
            const factory = await loadTextFactory(module);
            await assert.rejects(async () => {
              const built = factory(registered);
              await WebAssembly.compile(built.toBytes());
            });
            break;
          }
          case "assert_malformed": {
            assert.throws(
              () => readModule(command.module),
              (error) => error instanceof TextSyntaxError || error instanceof TypeError,
            );
            break;
          }
        }
      }
      result.passed++;
    } catch (error) {
      result.failures.push({
        command: index + 1,
        line: source.slice(0, position(expression)).split(/\r\n|[\r\n]/).length,
        kind,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
