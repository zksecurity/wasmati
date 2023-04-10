import { Undefined } from "../binable.js";
import { Const } from "../dependency.js";
import * as Dependency from "../dependency.js";
import { U32 } from "../immediate.js";
import { baseInstruction } from "./base.js";
import {
  Local,
  RefType,
  RefTypeObject,
  Type,
  ValueType,
  valueTypeLiteral,
} from "../types.js";
import { LocalContext } from "../local-context.js";

export {
  localOps,
  bindLocalOps,
  globalOps,
  bindGlobalOps,
  globalConstructor,
  refOps,
};

type AnyLocal = Local<ValueType>;

const localOps = {
  get: baseInstruction("local.get", U32, {
    create({ locals }, x: AnyLocal) {
      let local = locals[x.index];
      if (local === undefined)
        throw Error(`local with index ${x.index} not available`);
      return { in: [], out: [local] };
    },
    resolve: (_, x: AnyLocal) => x.index,
  }),
  set: baseInstruction("local.set", U32, {
    create({ locals }, x: AnyLocal) {
      let local = locals[x.index];
      if (local === undefined)
        throw Error(`local with index ${x.index} not available`);
      return { in: [local], out: [] };
    },
    resolve: (_, x: AnyLocal) => x.index,
  }),
  tee: baseInstruction("local.tee", U32, {
    create({ locals }, x: AnyLocal) {
      let type = locals[x.index];
      if (type === undefined)
        throw Error(`local with index ${x.index} not available`);
      return { in: [type], out: [type] };
    },
    resolve: (_, x: AnyLocal) => x.index,
  }),
};

function bindLocalOps(ctx: LocalContext) {
  return {
    get: function <T extends ValueType>(x: Local<T>) {
      return localOps.get(ctx, x) as Type<T>;
    },
    set: function <T extends ValueType>(x: Local<T>) {
      return localOps.set(ctx, x);
    },
    tee: function <T extends ValueType>(x: Local<T>) {
      return localOps.tee(ctx, x) as Type<T>;
    },
  };
}

const globalOps = {
  get: baseInstruction("global.get", U32, {
    create(_, global: Dependency.AnyGlobal<ValueType>) {
      return {
        in: [],
        out: [global.type.value],
        deps: [global],
      };
    },
    resolve: ([globalIdx]) => globalIdx,
  }),
  set: baseInstruction("global.set", U32, {
    create(_, global: Dependency.AnyGlobal<ValueType>) {
      if (!global.type.mutable) {
        throw Error("global.set used on immutable global");
      }
      return {
        in: [global.type.value],
        out: [],
        deps: [global],
      };
    },
    resolve: ([globalIdx]) => globalIdx,
  }),
};

function bindGlobalOps(ctx: LocalContext) {
  return {
    get: function <T extends ValueType>(x: Dependency.AnyGlobal<T>) {
      return globalOps.get(ctx, x) as Type<T>;
    },
    set: function <T extends ValueType>(x: Dependency.AnyGlobal<T>) {
      return globalOps.set(ctx, x);
    },
  };
}

function globalConstructor<T extends ValueType>(
  init: Const.t<T>,
  { mutable = false } = {}
): Dependency.Global<T> {
  let deps = init.deps as Dependency.Global<T>["deps"];
  let type = init.type.results[0];
  return { kind: "global", type: { value: type, mutable }, init, deps };
}

const refOps = {
  null: baseInstruction("ref.null", RefType, {
    create(_, type: RefTypeObject) {
      return {
        in: [],
        out: [valueTypeLiteral(type)],
        resolveArgs: [valueTypeLiteral(type)],
      };
    },
  }),
  is_null: baseInstruction("ref.is_null", Undefined, {
    create({ stack }: LocalContext) {
      return { in: [stack[stack.length - 1]], out: ["i32"] };
    },
    resolve: () => undefined,
  }),
  func: baseInstruction("ref.func", U32, {
    create(_, func: Dependency.AnyFunc) {
      return {
        in: [],
        out: ["funcref"],
        deps: [func, Dependency.hasRefTo(func)],
      };
    },
    resolve: ([funcIdx]) => funcIdx,
  }),
};
