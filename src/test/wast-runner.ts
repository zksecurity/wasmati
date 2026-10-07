import { Worker } from "node:worker_threads";
import {
  Module as Builder,
  func,
  importFunc,
  importGlobal,
  call,
  global,
  local,
  i32,
  i64,
  f32,
  f64,
  v128,
  i64x2,
  ref,
  extern,
  funcref,
  externref,
  exnref,
} from "../index.ts";
import type { Module as ModuleValue } from "../module-binable.ts";
import {
  type DefinedType,
  type FieldType,
  type FunctionType,
  type HeapType,
  isFunctionType,
  isHeapSubtype,
  isRefType,
  printValueType,
  referenced,
  referencedTypes,
  refType,
  type StorageType,
  type Type,
  type TypeDefinition,
  type ValueType,
} from "../types.ts";
import { jsLimits } from "../memory.ts";
import { TextSyntaxError, UnsupportedTextError, type List } from "../text/lexer.ts";
import {
  parseCommand,
  readScript,
  type Action,
  type Expected,
  type ModuleCommand,
  type Value,
} from "../text/wast.ts";
import { loadTextFactory, readModule } from "./text-helpers.ts";

export { runWast, runCommands };
export type { Result, Instance, SharedInstance };

type Failure = { command: number; line: number; kind: string; message: string };
/** Valid modules beyond the engine's implementation limits, which the spec permits, are skipped. */
type Result = { passed: number; failures: Failure[]; skipped: Failure[] };

type Instance = { instance: WebAssembly.Instance; module: ModuleValue };
type Factory = Awaited<ReturnType<typeof loadTextFactory>>;

/**
 * Run each script command through wasmati: modules are parsed, emitted as builder code, rebuilt and
 * instantiated. Actions run through wrapper modules, also built with wasmati, which exchange floats and
 * vectors as integer bits so that NaN payloads never pass through JS numbers.
 */
async function runWast(source: string): Promise<Result> {
  return runCommands(source, readScript(source), new Map());
}

/**
 * Run commands with named instances shared from an enclosing script. Threads run their commands in
 * workers, which receive the shared instances' shared memories, and report their results on wait.
 */
async function runCommands(
  source: string,
  lists: List[],
  shared: Map<string, Instance>,
): Promise<Result> {
  const result: Result = { passed: 0, failures: [], skipped: [] };
  const registered: WebAssembly.Imports = linked({ spectest: spectest() });
  const instances = new Map<string, Instance>(shared);
  // Names refer to the latest thread of that name; every thread's results are merged exactly once.
  const threads = new Map<string, Promise<Result>>();
  const unjoined = new Set<Promise<Result>>();
  const definitions = new Map<string, Factory>();
  const hosts = new Map<number, object>();
  const wrappers = new WeakMap<object, (...args: unknown[]) => unknown>();
  let current: Instance | undefined;

  function host(index: number) {
    if (!hosts.has(index)) hosts.set(index, { host: index });
    return hosts.get(index)!;
  }

  function target(module: string | undefined): Instance {
    const found = module === undefined ? current : instances.get(module);
    if (found === undefined) throw Error(`no module instance ${module ?? "<current>"}`);
    return found;
  }

  async function instantiate(factory: Factory, name: string | undefined) {
    current = undefined;
    const built = factory(registered);
    current = { instance: (await built.instantiate()).instance, module: built.module };
    if (name !== undefined) instances.set(name, current);
  }

  /** Perform an action, returning results with their types. Numbers are returned as unsigned bits. */
  async function perform(action: Action): Promise<{ type: ValueType; value: unknown }[]> {
    const { instance, module } = target(action.module);
    const exported = instance.exports[action.name];
    if (exported === undefined) throw Error(`unknown export ${action.name}`);
    const signature = exportSignature(module, action.name);
    let wrapper = wrappers.get(exported);
    if (wrapper === undefined) {
      wrapper = await buildWrapper(signature, exported);
      wrappers.set(exported, wrapper);
    }
    const args = action.kind === "invoke" ? action.args : [];
    if (args.length !== signature.args.length) throw Error("wrong number of arguments");
    const output = wrapper(...args.flatMap((arg, i) => toJS(arg, signature.args[i], host)));
    const values =
      signature.results.length === 1 && !Array.isArray(output)
        ? [output]
        : ((output as unknown[]) ?? []);
    let position = 0;
    return signature.results.map((type) => ({
      type,
      value: fromJS(type, values, position, (n) => (position += n)),
    }));
  }

  for (const [index, list] of lists.entries()) {
    let kind = list.items[0]?.kind === "atom" ? list.items[0].text : "<list>";
    try {
      const command = parseCommand(list);
      kind = command.kind;
      switch (command.kind) {
        case "module": {
          if (!command.definition) current = undefined;
          const factory = await loadModule(command);
          if (command.definition) {
            if (command.name !== undefined) definitions.set(command.name, factory);
          } else await instantiate(factory, command.name);
          break;
        }
        case "instance": {
          current = undefined;
          const factory = definitions.get(command.definition ?? "");
          if (factory === undefined) throw Error(`no module definition ${command.definition}`);
          await instantiate(factory, command.name);
          break;
        }
        case "register":
          registered[command.name] = target(command.module).instance.exports;
          break;
        case "action":
          await perform(command.action);
          break;
        case "assert_return": {
          const actual = await perform(command.action);
          if (actual.length !== command.expected.length)
            throw Error(`expected ${command.expected.length} results, got ${actual.length}`);
          command.expected.forEach((expected, i) => {
            if (!matches(expected, actual[i].type, actual[i].value, host))
              throw Error(`result ${i}: expected ${show(expected)}, got ${showActual(actual[i])}`);
          });
          break;
        }
        case "assert_trap":
          await rejects(perform(command.action), (error) => traps(error, command.message));
          break;
        case "assert_exhaustion":
          await rejects(perform(command.action), (error) => error instanceof RangeError);
          break;
        case "assert_exception":
          await rejects(perform(command.action), (error) => error instanceof WebAssembly.Exception);
          break;
        case "assert_trap_module": {
          const factory = await loadModule(command.module);
          await rejects(instantiate(factory, command.module.name), (error) =>
            traps(error, command.message),
          );
          break;
        }
        case "assert_unlinkable": {
          const factory = await loadModule(command.module);
          await rejects(
            (async () => factory(registered).instantiate())(),
            (error) => error instanceof WebAssembly.LinkError,
          );
          break;
        }
        case "assert_invalid": {
          // The module must parse: an invalid module is well-formed. Any later stage may reject it,
          // but not merely because a feature is unsupported.
          const module = readModule(command.module.source);
          await rejects(
            (async () => {
              const factory = await loadTextFactory(module);
              await WebAssembly.compile(factory(placeholders(module, registered)).toBytes());
            })(),
            (error) => !unsupported(error) && !(error instanceof WebAssembly.LinkError),
          );
          break;
        }
        case "thread": {
          const thread = startThread(source, command.commands, command.shared, instances);
          // A thread that fails to run is a failure of its command.
          const line = lineOf(source, list);
          const failed = (error: unknown) => ({
            passed: 0,
            failures: [{ command: index + 1, line, kind, message: messageOf(error) }],
            skipped: [],
          });
          const joinable = thread.catch(failed);
          threads.set(command.name, joinable);
          unjoined.add(joinable);
          break;
        }
        case "wait": {
          const thread = threads.get(command.name);
          if (thread === undefined) throw Error(`no thread ${command.name}`);
          const results = await thread;
          if (unjoined.delete(thread)) merge(result, results);
          break;
        }
        case "assert_malformed": {
          const { source } = command.module;
          // Text must fail with a syntax error, not an unsupported feature; binary must fail to decode.
          await rejects(
            (async () => readModule(source))(),
            (error) => source.kind === "binary" || error instanceof TextSyntaxError,
          );
          break;
        }
      }
      result.passed++;
    } catch (error) {
      const message = messageOf(error);
      const limited = kind === "module" && /larger than implementation limit/.test(message);
      (limited ? result.skipped : result.failures).push({
        command: index + 1,
        line: lineOf(source, list),
        kind,
        message,
      });
    }
  }
  for (const thread of unjoined) merge(result, await thread);
  return result;
}

function lineOf(source: string, list: List) {
  return source.slice(0, list.offset).split(/\r\n|[\r\n]/).length;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function merge(result: Result, thread: Result) {
  result.passed += thread.passed;
  result.failures.push(...thread.failures);
  result.skipped.push(...thread.skipped);
}

/** Instances cross into threads with the exports that can be shared: shared memories. */
type SharedInstance = { exports: Record<string, WebAssembly.Memory>; module: ModuleValue };

function startThread(
  source: string,
  commands: List[],
  names: string[],
  instances: Map<string, Instance>,
): Promise<Result> {
  const shared = names.map((name): [string, SharedInstance] => {
    const found = instances.get(name);
    if (found === undefined) throw Error(`no module instance ${name}`);
    const exports = Object.fromEntries(
      Object.entries(found.instance.exports).filter(
        ([, value]) =>
          value instanceof WebAssembly.Memory && value.buffer instanceof SharedArrayBuffer,
      ),
    ) as Record<string, WebAssembly.Memory>;
    return [name, { exports, module: found.module }];
  });
  const worker = new Worker(new URL("./wast-thread.ts", import.meta.url), {
    workerData: { source, commands, shared },
  });
  return new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => reject(Error(`thread exited with code ${code}`)));
  });
}

async function loadModule(command: ModuleCommand): Promise<Factory> {
  return loadTextFactory(readModule(command.source));
}

/** V8's messages for the traps of the spec suite, keyed by the start of the spec's message. */
const trapMessages: [string, RegExp][] = [
  ["unreachable", /unreachable/],
  ["integer divide by zero", /(divide|remainder) by zero/],
  ["integer overflow", /divide result unrepresentable|float unrepresentable in integer range/],
  ["invalid conversion to integer", /float unrepresentable in integer range/],
  [
    "out of bounds memory access",
    /memory access out of bounds|data segment (\d+ is )?out of bounds/,
  ],
  ["out of bounds table access", /table index is out of bounds|element segment out of bounds/],
  ["undefined element", /table index is out of bounds/],
  ["uninitialized element", /null function/],
  ["indirect call type mismatch", /function signature mismatch/],
  ["out of bounds", /out of bounds/],
  ["null function reference", /dereferencing a null pointer/],
  ["null", /dereferencing a null pointer|null/],
  ["cast", /illegal cast/],
  ["unaligned atomic", /unaligned/],
  ["expected shared memory", /Atomics.wait cannot be called in this context/],
  ["indirect call", /function signature mismatch|null function/],
];

/** A trap matches if V8 reports the same kind of trap as the spec message. */
function traps(error: unknown, message: string): boolean {
  if (!(error instanceof WebAssembly.RuntimeError)) return false;
  const expected = trapMessages.find(([prefix]) => message.startsWith(prefix));
  if (expected === undefined) throw Error(`unknown trap message "${message}"`);
  if (!expected[1].test(error.message))
    throw Error(`expected trap "${message}", got "${error.message}"`);
  return true;
}

/**
 * Imports for compiling a module that is expected to be invalid: missing imports get placeholders,
 * so that a link error cannot stand in for invalidity.
 */
function placeholders(module: ModuleValue, imports: WebAssembly.Imports): WebAssembly.Imports {
  const result: Record<string, Record<string, unknown>> = {};
  for (const { module: from, name, description } of module.imports) {
    const fields = (result[from] ??= {});
    const provided = imports[from];
    if (name in fields || (provided !== undefined && name in provided)) {
      fields[name] ??= provided?.[name];
      continue;
    }
    if (description.kind === "function") fields[name] = () => {};
    else if (description.kind === "memory")
      fields[name] = new WebAssembly.Memory(jsLimits(description.value.limits));
    else if (description.kind === "table") {
      const { type, limits } = description.value;
      const element = type === "funcref" ? "anyfunc" : "externref";
      fields[name] = new WebAssembly.Table({
        ...jsLimits(limits),
        element,
      } as WebAssembly.TableDescriptor);
    } else if (description.kind === "tag") {
      const type = module.types[description.value];
      const parameters = type !== undefined && isFunctionType(type) ? type.args : [];
      if (parameters.some((t) => isRefType(t) && t !== "funcref" && t !== "externref"))
        throw Error("placeholders for tags of these types are not supported");
      fields[name] = new WebAssembly.Tag({
        parameters: parameters.map((t) =>
          t === "funcref" ? "anyfunc" : t,
        ) as WebAssembly.ValueType[],
      });
    } else {
      const { value, mutable } = description.value;
      if (value === "v128" || (isRefType(value) && value !== "funcref" && value !== "externref"))
        throw Error("placeholders for globals of this type are not supported");
      const type = (value === "funcref" ? "anyfunc" : value) as WebAssembly.ValueType;
      const initial = type === "i64" ? 0n : type === "anyfunc" || type === "externref" ? null : 0;
      fields[name] = new WebAssembly.Global({ value: type, mutable }, initial);
    }
  }
  return result as WebAssembly.Imports;
}

function unsupported(error: unknown): boolean {
  return (
    error instanceof UnsupportedTextError ||
    /not (yet )?(supported|implemented)/i.test(String(error))
  );
}

async function rejects(promise: Promise<unknown>, expected: (error: unknown) => boolean) {
  try {
    await promise;
  } catch (error) {
    if (expected(error)) return;
    throw error;
  }
  throw Error("expected failure, but it succeeded");
}

/**
 * Generated factories read imports at build time and would substitute fresh objects for missing ones,
 * so unknown imports throw the link error that instantiation would report.
 */
function linked(imports: WebAssembly.Imports): WebAssembly.Imports {
  return new Proxy(imports, {
    get(modules, module: string) {
      return new Proxy(modules[module] ?? {}, {
        get(fields, field: string) {
          if (!(field in fields))
            throw new WebAssembly.LinkError(`unknown import ${module}.${field}`);
          return fields[field];
        },
      });
    },
  });
}

/** The host module of the official test suite. */
function spectest(): WebAssembly.ModuleImports {
  const print = () => {};
  return {
    print,
    print_i32: print,
    print_i64: print,
    print_f32: print,
    print_f64: print,
    print_i32_f32: print,
    print_f64_f64: print,
    global_i32: new WebAssembly.Global({ value: "i32" }, 666),
    global_i64: new WebAssembly.Global({ value: "i64" }, 666n),
    global_f32: new WebAssembly.Global({ value: "f32" }, 666.6),
    global_f64: new WebAssembly.Global({ value: "f64" }, 666.6),
    table: new WebAssembly.Table({ initial: 10, maximum: 20, element: "anyfunc" }),
    table64: new WebAssembly.Table({
      ...jsLimits({ min: 10, max: 20, shared: false, address: "i64" }),
      element: "anyfunc",
    } as WebAssembly.TableDescriptor),
    memory: new WebAssembly.Memory({ initial: 1, maximum: 2 }),
  };
}

/** An export's type: a function's signature and defined type, or a global's type as a result. */
type Signature = FunctionType & { defined?: DefinedType; global?: { mutable: boolean } };

/** Exported globals are treated like functions without parameters that return the global's value. */
function exportSignature(module: ModuleValue, name: string): Signature {
  const description = module.exports.find((e) => e.name === name)?.description;
  if (description === undefined) throw Error(`unknown export ${name}`);
  const imported = (kind: string) => module.imports.filter((i) => i.description.kind === kind);
  if (description.kind === "function") {
    const imports = imported("function");
    const typeIndex =
      description.value < imports.length
        ? (imports[description.value].description.value as number)
        : module.funcs[description.value - imports.length].typeIdx;
    const type = module.types[typeIndex];
    if (!isFunctionType(type)) throw Error(`export ${name} does not have a function type`);
    return {
      args: type.args.map((t) => lift(module, t)),
      results: type.results.map((t) => lift(module, t)),
      defined: (lift(module, refType(typeIndex, false)) as { ref: DefinedType }).ref,
    };
  }
  if (description.kind === "global") {
    const imports = imported("global");
    const type =
      description.value < imports.length
        ? (imports[description.value].description.value as { value: ValueType; mutable: boolean })
        : module.globals[description.value - imports.length].type;
    return { args: [], results: [lift(module, type.value)], global: { mutable: type.mutable } };
  }
  throw Error(`export ${name} is not a function or global`);
}

const types = { i32, i64, f32, f64, v128, funcref, externref, exnref } as const;

/** The builder type object of a value type. */
function typeObject(type: ValueType): Type<ValueType> {
  return typeof type === "object" || !(type in types)
    ? { kind: type }
    : types[type as keyof typeof types];
}

/**
 * Builders refer to defined types as objects. Rebuild the module's types in their recursion groups,
 * so that a wrapper module defines equivalent types.
 */
const builderTypes = new WeakMap<ModuleValue, DefinedType[]>();
function lift(module: ModuleValue, type: ValueType): ValueType {
  if (typeof type !== "object" || typeof type.ref !== "number") return type;
  let defined = builderTypes.get(module);
  if (defined === undefined) builderTypes.set(module, (defined = defineTypes(module)));
  return { ref: defined[type.ref], nullable: type.nullable };
}

function defineTypes(module: ModuleValue): DefinedType[] {
  const defined: DefinedType[] = [];
  const heap = (h: HeapType) => (typeof h === "number" ? defined[h] : h);
  const value = <T extends StorageType>(t: T): T =>
    typeof t === "object" ? ({ ref: heap(t.ref), nullable: t.nullable } as T) : t;
  let start = 0;
  for (const size of module.recGroups ?? module.types.map(() => 1)) {
    const group = Array.from({ length: size }, (_, i): DefinedType => {
      const type: DefinedType = { kind: "type", type: {} as TypeDefinition, deps: [] };
      defined[start + i] = type;
      return type;
    });
    group.forEach((type, i) => {
      const definition = module.types[start + i];
      const field = (f: FieldType) => ({ type: value(f.type), mutable: f.mutable });
      const composite =
        "struct" in definition
          ? { struct: definition.struct.map(field) }
          : "array" in definition
            ? { array: field(definition.array) }
            : { args: definition.args.map(value), results: definition.results.map(value) };
      type.type = {
        ...composite,
        ...(definition.final === false ? { final: false as const } : {}),
        ...(definition.supertype === undefined
          ? {}
          : { supertype: heap(definition.supertype) as DefinedType }),
      };
      type.deps = referencedTypes(type.type);
      if (size > 1) type.group = group;
    });
    start += size;
  }
  return defined;
}

/** Types that cross the JS boundary: floats as integer bits, vectors as two 64-bit halves. */
function jsTypes(type: ValueType): ValueType[] {
  if (isException(type)) return ["i32"];
  return type === "f32"
    ? ["i32"]
    : type === "f64"
      ? ["i64"]
      : type === "v128"
        ? ["i64", "i64"]
        : [type];
}

/**
 * Internal references pass out of the wrapper as external references, with a bitmask of whether they
 * are i31 (1), struct (2) or array (4) references.
 */
function isInternal(type: ValueType): boolean {
  return isRefType(type) && isHeapSubtype(referenced(type).ref, "any");
}

/** The wrapper's outputs for a result. */
function resultTypes(type: ValueType): ValueType[] {
  return isInternal(type) ? ["externref", "i32"] : jsTypes(type);
}

/** Exception references cannot pass into JS; the wrapper returns whether they are null instead. */
function isException(type: ValueType): boolean {
  return isRefType(type) && ["exn", "noexn"].includes(referenced(type).ref as string);
}

async function buildWrapper(signature: Signature, exported: unknown) {
  const params = signature.args
    .flatMap(jsTypes)
    .map((type, i) => ({ [`p${i}`]: typeObject(type) }));
  const locals = Object.fromEntries(
    signature.results.map((type, i) => [`r${i}`, typeObject(type)]),
  );
  const out = signature.results.flatMap(resultTypes).map(typeObject);
  const imported =
    signature.global === undefined
      ? importFunc(
          {
            in: signature.args.map((type, i) => ({ [`a${i}`]: typeObject(type) })),
            out: signature.results.map(typeObject),
            type: signature.defined,
          } as any,
          exported as any,
        )
      : importGlobal(
          typeObject(signature.results[0]) as any,
          exported as WebAssembly.Global,
          signature.global,
        );
  const wrapper = func({ in: params, locals, out } as any, (args: any, results: any) => {
    let p = 0;
    for (const type of signature.args) {
      local.get(args[`p${p++}`]);
      if (type === "f32") f32.reinterpret_i32();
      if (type === "f64") f64.reinterpret_i64();
      if (type === "v128") {
        i64x2.splat();
        local.get(args[`p${p++}`]);
        i64x2.replace_lane(1);
      }
    }
    if (signature.global === undefined) call(imported as any);
    else global.get(imported as any);
    for (let i = signature.results.length - 1; i >= 0; i--) local.set(results[`r${i}`]);
    signature.results.forEach((type, i) => {
      local.get(results[`r${i}`]);
      if (type === "f32") i32.reinterpret_f32();
      if (type === "f64") i64.reinterpret_f64();
      if (type === "v128") {
        i64x2.extract_lane(0);
        local.get(results[`r${i}`]);
        i64x2.extract_lane(1);
      }
      if (isException(type)) ref.is_null();
      if (isInternal(type)) {
        extern.convert_any();
        (["i31", "struct", "array"] as const).forEach((kind, bit) => {
          local.get(results[`r${i}`]);
          ref.test({ kind: refType(kind, false) });
          if (bit > 0) {
            i32.const(bit);
            i32.shl();
            i32.or();
          }
        });
      }
    });
  });
  const { instance } = await Builder({ exports: { wrapper } }).instantiate();
  return instance.exports.wrapper as (...args: unknown[]) => unknown;
}

function toJS(value: Value, type: ValueType, host: (index: number) => object): unknown[] {
  if (value.type === "ref") return [value.ref === "null" ? null : host(value.host!)];
  if (value.type !== type) throw Error(`argument of type ${value.type} for a ${type} parameter`);
  const bits = value.lanes.reduceRight((all, lane) => (all << BigInt(lane.width)) | lane.value, 0n);
  if (type === "i32" || type === "f32") return [Number(BigInt.asIntN(32, bits))];
  if (type === "i64" || type === "f64") return [BigInt.asIntN(64, bits)];
  return [BigInt.asIntN(64, bits), BigInt.asIntN(64, bits >> 64n)];
}

/** Read one result from the wrapper's outputs, as unsigned bits for numbers. */
function fromJS(
  type: ValueType,
  values: unknown[],
  position: number,
  advance: (n: number) => void,
) {
  const width = resultTypes(type).length;
  advance(width);
  const at = (i: number) => values[position + i];
  if (type === "i32" || type === "f32") return BigInt.asUintN(32, BigInt(at(0) as number));
  if (type === "i64" || type === "f64") return BigInt.asUintN(64, at(0) as bigint);
  if (type === "v128")
    return BigInt.asUintN(64, at(0) as bigint) | (BigInt.asUintN(64, at(1) as bigint) << 64n);
  if (isException(type)) return at(0) === 1 ? null : { exception: true };
  if (isInternal(type)) return at(0) === null ? null : { reference: at(0), kinds: at(1) as number };
  return at(0);
}

function matches(
  expected: Expected,
  type: ValueType,
  actual: unknown,
  host: (index: number) => object,
): boolean {
  if (expected.type === "either")
    return expected.options.some((option) => matches(option, type, actual, host));
  if (expected.type === "ref") {
    if (!isRefType(type)) return false;
    if (expected.ref === "null") return actual === null;
    if (expected.ref === "func") return typeof actual === "function";
    const internal = isInternal(type) ? (actual as Internal | null) : undefined;
    if (expected.ref === "extern") {
      const reference = internal === undefined ? actual : internal?.reference;
      return expected.host === undefined ? reference != null : reference === host(expected.host);
    }
    const bits = { i31: 1, struct: 2, array: 4, eq: 7 }[expected.ref];
    return ((internal?.kinds ?? 0) & bits) !== 0;
  }
  if (expected.type !== type) return false;
  let offset = 0n;
  return expected.lanes.every(({ width, value, mask }) => {
    const lane = ((actual as bigint) >> offset) & ((1n << BigInt(width)) - 1n);
    offset += BigInt(width);
    return (lane & mask) === value;
  });
}

type Internal = { reference: unknown; kinds: number };

function show(expected: Expected): string {
  if (expected.type === "either") return `either(${expected.options.map(show).join(", ")})`;
  if (expected.type === "ref")
    return `ref.${expected.ref}${expected.host === undefined ? "" : ` ${expected.host}`}`;
  return `${expected.type} ${expected.lanes.map((lane) => "0x" + lane.value.toString(16)).join(" ")}`;
}

function showActual({ type, value }: { type: ValueType; value: unknown }): string {
  const name = printValueType(type);
  return typeof value === "bigint" ? `${name} 0x${value.toString(16)}` : `${name} ${String(value)}`;
}
