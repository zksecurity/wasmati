import * as C from "../codec.ts";
import type { Module as ModuleValue } from "../module-binable.ts";
import { TextSyntaxError } from "./lexer.ts";
import { form, head, optional, position, record, token } from "./grammar.ts";
import { Identifier, I32, I64, Name, Script, Text, type Expression } from "./text.ts";
import { ModuleSyntax } from "./module.ts";
import { UnsupportedTextError } from "./lexer.ts";

export { Wast, Command, Action, Constant };
export type { Command as CommandValue, Action as ActionValue, Constant as ConstantValue };

type Constant = { type: "i32"; value: number } | { type: "i64"; value: bigint };
const Constant: C.Codec<Constant, Expression> = {
  encode(value) {
    return value.type === "i32"
      ? form("i32.const", token(I32)).encode(value.value)
      : form("i64.const", token(I64)).encode(value.value);
  },
  decode(input, offset) {
    const name = head(input[offset]);
    if (name === "i32.const") {
      const [value, end] = form(name, token(I32)).decode(input, offset);
      return [{ type: "i32", value }, end];
    }
    if (name === "i64.const") {
      const [value, end] = form(name, token(I64)).decode(input, offset);
      return [{ type: "i64", value }, end];
    }
    throw new UnsupportedTextError(`WAST constant ${name} is not implemented`);
  },
};
const moduleId = optional(
  token(Identifier),
  (node) => !Array.isArray(node) && node?.kind === "identifier",
);
const Invoke = form(
  "invoke",
  record({ module: moduleId, field: token(Name), args: C.sequence(Constant) }),
);
const Get = form("get", record({ module: moduleId, field: token(Name) }));
type Action =
  | { kind: "invoke"; module: string | undefined; field: string; args: Constant[] }
  | { kind: "get"; module: string | undefined; field: string };
const Action: C.Codec<Action, Expression> = {
  encode(action) {
    return action.kind === "invoke" ? Invoke.encode(action) : Get.encode(action);
  },
  decode(input, offset) {
    const name = head(input[offset]);
    if (name === "invoke") {
      const [value, end] = Invoke.decode(input, offset);
      return [{ kind: "invoke", ...value }, end];
    }
    if (name === "get") {
      const [value, end] = Get.decode(input, offset);
      return [{ kind: "get", ...value }, end];
    }
    throw new UnsupportedTextError(`WAST action ${name} is not implemented`);
  },
};
const AssertReturn = form(
  "assert_return",
  record({ action: Action, expected: C.sequence(Constant) }),
);
const AssertTrap = form("assert_trap", record({ action: Action, message: token(Name) }));
const RawModule: C.Codec<Expression, Expression> = {
  encode: (value) => [value],
  decode(input, offset) {
    const value = input[offset];
    if (head(value) !== "module") throw new TextSyntaxError("expected module", position(value));
    return [value, offset + 1];
  },
};
const AssertInvalid = form("assert_invalid", record({ module: RawModule, message: token(Name) }));
const AssertMalformed = form(
  "assert_malformed",
  record({ module: RawModule, message: token(Name) }),
);
const Register = form("register", record({ name: token(Name), module: moduleId }));

type Command =
  | { kind: "module"; module: ModuleValue }
  | { kind: "register"; name: string; module: string | undefined }
  | Action
  | { kind: "assert_return"; action: Action; expected: Constant[] }
  | { kind: "assert_trap"; action: Action; message: string }
  | { kind: "assert_invalid" | "assert_malformed"; module: Expression; message: string };

/** Script commands have their own grammar; negative assertions retain module syntax until execution. */
const Command: C.Codec<Command, Expression> = {
  encode(command) {
    switch (command.kind) {
      case "module":
        return ModuleSyntax.encode(command.module);
      case "register":
        return Register.encode(command);
      case "invoke":
      case "get":
        return Action.encode(command);
      case "assert_return":
        return AssertReturn.encode(command);
      case "assert_trap":
        return AssertTrap.encode(command);
      case "assert_invalid":
        return AssertInvalid.encode(command);
      case "assert_malformed":
        return AssertMalformed.encode(command);
    }
  },
  decode(input, offset) {
    const name = head(input[offset]);
    switch (name) {
      case "module": {
        const [module, end] = ModuleSyntax.decode(input, offset);
        return [{ kind: "module", module }, end];
      }
      case "invoke":
      case "get":
        return Action.decode(input, offset);
      case "register": {
        const [value, end] = Register.decode(input, offset);
        return [{ kind: name, ...value }, end];
      }
      case "assert_return": {
        const [value, end] = AssertReturn.decode(input, offset);
        return [{ kind: name, ...value }, end];
      }
      case "assert_trap": {
        const [value, end] = AssertTrap.decode(input, offset);
        return [{ kind: name, ...value }, end];
      }
      case "assert_invalid":
      case "assert_malformed": {
        const [value, end] = (name === "assert_invalid" ? AssertInvalid : AssertMalformed).decode(
          input,
          offset,
        );
        return [{ kind: name, ...value }, end];
      }
      default:
        throw new UnsupportedTextError(`WAST command ${name} is not implemented`);
    }
  },
};
const Commands = C.sequence(Command);
const Wast = Text(
  C.iso(Script, {
    to: (commands: Command[]) => Commands.encode(commands),
    from: (expressions) => Commands.decode(expressions, 0)[0],
  }),
);
