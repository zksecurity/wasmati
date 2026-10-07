import type { ESTree } from "meriyah";

export { analyzeScopes, freeReferences, contains, type Scope, type Reference, type Scopes };

type Node = ESTree.Node;

/** A scope: the module, a function, a block, a class, or a catch clause. */
type Scope = {
  node: Node;
  parent: Scope | undefined;
  /** Bindings declared in the scope; at module level, the top-level statement declaring each. */
  declarations: Map<string, Node>;
  isFunction: boolean;
};

/** A use of a name, which writes to it if it is assigned. `declaration` is undefined for globals. */
type Reference = {
  name: string;
  node: ESTree.Identifier;
  write: boolean;
  declaration: Scope | undefined;
};

type Scopes = { module: Scope; references: Reference[] };

/** Ranges are offsets into the source; meriyah's `ranges` option provides them. */
function contains(outer: Node, inner: Node) {
  return outer.start! <= inner.start! && inner.end! <= outer.end!;
}

/** References within a node to names declared outside of it, or not declared at all. */
function freeReferences({ references }: Scopes, node: Node): Reference[] {
  return references.filter(
    (reference) =>
      contains(node, reference.node) &&
      (reference.declaration === undefined || !contains(node, reference.declaration.node)),
  );
}

/**
 * Find the scopes of a module and resolve every reference to the scope that declares it. Var and
 * function declarations are hoisted to their function, other declarations belong to their block.
 */
function analyzeScopes(program: ESTree.Program): Scopes {
  const module: Scope = {
    node: program,
    parent: undefined,
    declarations: new Map(),
    isFunction: true,
  };
  const pending: { name: string; node: ESTree.Identifier; write: boolean; scope: Scope }[] = [];
  // The top-level statement being visited, which declares module-level bindings.
  let statement: Node = program;

  const child = (node: Node, parent: Scope, isFunction = false): Scope => ({
    node,
    parent,
    declarations: new Map(),
    isFunction,
  });
  const functionScope = (scope: Scope) => {
    while (!scope.isFunction) scope = scope.parent!;
    return scope;
  };
  const declare = (name: string, scope: Scope) =>
    scope.declarations.set(name, scope === module ? statement : scope.node);
  const reference = (node: ESTree.Identifier, scope: Scope, write = false) => {
    pending.push({ name: node.name, node, write, scope });
  };

  /** Declare the names of a binding pattern, and visit the expressions in it. */
  function bind(pattern: Node, scope: Scope, target: Scope, write = false) {
    switch (pattern.type) {
      case "Identifier":
        if (write) reference(pattern, scope, true);
        else declare(pattern.name, target);
        return;
      case "ObjectPattern":
        for (const property of pattern.properties) {
          if (property.type === "RestElement") bind(property.argument, scope, target, write);
          else {
            if (property.computed) visit(property.key, scope);
            bind(property.value, scope, target, write);
          }
        }
        return;
      case "ArrayPattern":
        for (const element of pattern.elements) if (element) bind(element, scope, target, write);
        return;
      case "RestElement":
        return bind(pattern.argument, scope, target, write);
      case "AssignmentPattern":
        bind(pattern.left, scope, target, write);
        if (pattern.right) visit(pattern.right, scope);
        return;
      default:
        // Assignment targets may be member expressions.
        return visit(pattern, scope);
    }
  }

  function visitFunction(
    node: ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
    scope: Scope,
  ) {
    const inner = child(node, scope, true);
    if (node.type === "FunctionExpression" && node.id) declare(node.id.name, inner);
    for (const parameter of node.params) bind(parameter, inner, inner);
    if (node.body?.type === "BlockStatement") visitStatements(node.body.body, inner);
    else if (node.body) visit(node.body, inner);
  }

  function visitClass(node: ESTree.ClassDeclaration | ESTree.ClassExpression, scope: Scope) {
    const inner = child(node, scope);
    if (node.id) declare(node.id.name, inner);
    if (node.superClass) visit(node.superClass, inner);
    for (const element of node.body.body) {
      if (element.type === "StaticBlock") {
        visitStatements(element.body, child(element, inner, true));
        continue;
      }
      if ("computed" in element && element.computed) visit(element.key as Node, inner);
      if ("value" in element && element.value) visit(element.value as Node, inner);
    }
  }

  function visitStatements(statements: Node[], scope: Scope) {
    for (const node of statements) visit(node, scope);
  }

  function visit(node: Node, scope: Scope): void {
    switch (node.type) {
      case "Identifier":
        return reference(node, scope);
      case "ImportDeclaration":
        for (const specifier of node.specifiers) declare(specifier.local.name, scope);
        return;
      case "ExportNamedDeclaration":
        if (node.declaration) visit(node.declaration, scope);
        else if (!node.source)
          for (const specifier of node.specifiers)
            if (specifier.local.type === "Identifier") reference(specifier.local, scope);
        return;
      case "ExportDefaultDeclaration":
        return visit(node.declaration as Node, scope);
      case "ExportAllDeclaration":
        return;
      case "VariableDeclaration": {
        const target = node.kind === "var" ? functionScope(scope) : scope;
        for (const declarator of node.declarations) {
          bind(declarator.id, scope, target);
          if (declarator.init) visit(declarator.init, scope);
        }
        return;
      }
      case "FunctionDeclaration":
        if (node.id) declare(node.id.name, scope);
        return visitFunction(node, scope);
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return visitFunction(node, scope);
      case "ClassDeclaration":
        if (node.id) declare(node.id.name, scope);
        return visitClass(node, scope);
      case "ClassExpression":
        return visitClass(node, scope);
      case "BlockStatement":
      case "StaticBlock":
        return visitStatements(node.body, child(node, scope));
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const inner = child(node, scope);
        if (node.type === "ForStatement") {
          if (node.init) visit(node.init, inner);
          if (node.test) visit(node.test, inner);
          if (node.update) visit(node.update, inner);
        } else {
          if (node.left.type === "VariableDeclaration") visit(node.left, inner);
          else bind(node.left, inner, inner, true);
          visit(node.right, inner);
        }
        return visit(node.body, inner);
      }
      case "CatchClause": {
        const inner = child(node, scope);
        if (node.param) bind(node.param, inner, inner);
        return visit(node.body, inner);
      }
      case "SwitchStatement": {
        visit(node.discriminant, scope);
        const inner = child(node, scope);
        for (const switchCase of node.cases) {
          if (switchCase.test) visit(switchCase.test, inner);
          visitStatements(switchCase.consequent, inner);
        }
        return;
      }
      case "LabeledStatement":
        return visit(node.body, scope);
      case "BreakStatement":
      case "ContinueStatement":
      case "MetaProperty":
      case "Literal":
      case "PrivateIdentifier":
      case "Super":
      case "ThisExpression":
      case "TemplateElement":
        return;
      case "MemberExpression":
        visit(node.object, scope);
        if (node.computed) visit(node.property as Node, scope);
        return;
      case "Property":
        if (node.computed) visit(node.key, scope);
        return visit(node.value as Node, scope);
      case "AssignmentExpression":
        // Compound assignments also read their target.
        if (node.operator !== "=" && node.left.type === "Identifier") reference(node.left, scope);
        bind(node.left, scope, scope, true);
        return visit(node.right, scope);
      case "UpdateExpression":
        if (node.argument.type === "Identifier") {
          reference(node.argument, scope);
          return reference(node.argument, scope, true);
        }
        return visit(node.argument, scope);
      default:
        for (const [key, value] of Object.entries(node)) {
          if (
            key === "type" ||
            key === "start" ||
            key === "end" ||
            key === "range" ||
            key === "loc"
          )
            continue;
          for (const item of Array.isArray(value) ? value : [value])
            if (item !== null && typeof item === "object" && typeof item.type === "string")
              visit(item, scope);
        }
    }
  }

  for (const node of program.body) {
    statement = node;
    visit(node, module);
  }
  const references = pending.map(({ name, node, write, scope }) => {
    let declaration: Scope | undefined = scope;
    while (declaration !== undefined && !declaration.declarations.has(name))
      declaration = declaration.parent;
    return { name, node, write, declaration };
  });
  return { module, references };
}
