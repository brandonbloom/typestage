/**
 * Shared syntactic scope helpers for residual TypeScript.
 * These helpers intentionally model the binding shapes TypeStage needs for
 * hygiene and residual import decisions, not the full TypeScript checker.
 */
import * as ts from "typescript";

export type BindingNameCollector = (
  name: ts.BindingName,
  names: Set<string>,
) => void;

export type ScopedReferenceVisitor = {
  collectBindingName?: BindingNameCollector;
  onValueReference?: (
    identifier: ts.Identifier,
    scopes: readonly Set<string>[],
  ) => void;
  onTypeReference?: (
    node: ts.TypeReferenceNode,
    name: ts.Identifier | undefined,
    scopes: readonly Set<string>[],
  ) => void;
};

export function bindingNames(name: ts.BindingName): string[] {
  const names = new Set<string>();

  collectBindingName(name, names);

  return Array.from(names);
}

export function collectBindingName(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) {
      continue;
    }

    collectBindingName(element.name, names);
  }
}

export function collectBindingsInNode(node: ts.Node, names: Set<string>) {
  if (ts.isVariableDeclaration(node)) {
    collectBindingName(node.name, names);
  } else if (ts.isParameter(node)) {
    collectBindingName(node.name, names);
  } else if (ts.isFunctionDeclaration(node) && node.name) {
    names.add(node.name.text);
  } else if (ts.isFunctionExpression(node) && node.name) {
    names.add(node.name.text);
  } else if (ts.isClassDeclaration(node) && node.name) {
    names.add(node.name.text);
  } else if (ts.isClassExpression(node) && node.name) {
    names.add(node.name.text);
  } else if (ts.isImportClause(node)) {
    if (node.name) {
      names.add(node.name.text);
    }
  } else if (ts.isImportSpecifier(node)) {
    names.add(node.name.text);
  } else if (ts.isNamespaceImport(node)) {
    names.add(node.name.text);
  } else if (ts.isTypeParameterDeclaration(node)) {
    names.add(node.name.text);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    collectBindingName(node.variableDeclaration.name, names);
  }

  ts.forEachChild(node, (child) => collectBindingsInNode(child, names));
}

export function collectLocalBindingNames(nodes: readonly ts.Node[]): Set<string> {
  const names = new Set<string>();

  for (const node of nodes) {
    collectBindingsInNode(node, names);
  }

  return names;
}

function collectDirectBindingNames(
  node: ts.Node,
  names: Set<string>,
  collectName: BindingNameCollector = collectBindingName,
) {
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      collectName(declaration.name, names);
    }
    return;
  }

  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    names.add(node.name.text);
    return;
  }

  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;

    if (clause?.name) {
      names.add(clause.name.text);
    }

    const namedBindings = clause?.namedBindings;

    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      names.add(namedBindings.name.text);
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const specifier of namedBindings.elements) {
        names.add(specifier.name.text);
      }
    }
  }
}

export function freeReferenceNames(nodes: readonly ts.Node[]): Set<string> {
  const names = new Set<string>();

  walkScopedReferences(nodes, {
    onValueReference(identifier) {
      names.add(identifier.text);
    },
  });

  return names;
}

export function referenceIdentifiers(nodes: readonly ts.Node[]): Set<string> {
  return freeReferenceNames(nodes);
}

export function walkScopedReferences(
  nodes: readonly ts.Node[],
  visitor: ScopedReferenceVisitor,
) {
  const collectName = visitor.collectBindingName ?? collectBindingName;

  const visit = (node: ts.Node, scopes: readonly Set<string>[]) => {
    if (ts.isTypeReferenceNode(node)) {
      const name = typeReferenceIdentifier(node);

      if (name && !isNameBound(name.text, scopes)) {
        visitor.onTypeReference?.(node, name, scopes);
      }

      ts.forEachChild(node, (child) => visit(child, scopes));
      return;
    }

    if (
      ts.isIdentifier(node) &&
      isReferenceIdentifier(node) &&
      !isNameBound(node.text, scopes)
    ) {
      visitor.onValueReference?.(node, scopes);
    }

    if (isFunctionLikeWithBody(node)) {
      const scope = new Set<string>();

      if (ts.isFunctionExpression(node) && node.name) {
        scope.add(node.name.text);
      }

      if (node.typeParameters) {
        for (const parameter of node.typeParameters) {
          scope.add(parameter.name.text);
        }
      }

      for (const parameter of node.parameters) {
        collectName(parameter.name, scope);
      }

      if (node.body) {
        visitNodeList([node.body], [...scopes, scope]);
      }
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      const scope = new Set<string>();

      for (const parameter of node.typeParameters ?? []) {
        scope.add(parameter.name.text);
      }

      visit(node.type, [...scopes, scope]);
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const scope = new Set<string>();

      for (const parameter of node.typeParameters ?? []) {
        scope.add(parameter.name.text);
      }

      for (const member of node.members) {
        visit(member, [...scopes, scope]);
      }
      return;
    }

    if (ts.isForStatement(node)) {
      const scope = new Set<string>();

      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          collectName(declaration.name, scope);
        }
      }

      ts.forEachChild(node, (child) => visit(child, [...scopes, scope]));
      return;
    }

    if (ts.isCatchClause(node)) {
      const scope = new Set<string>();

      if (node.variableDeclaration) {
        collectName(node.variableDeclaration.name, scope);
      }

      visit(node.block, [...scopes, scope]);
      return;
    }

    if (ts.isConditionalTypeNode(node)) {
      visit(node.checkType, scopes);
      visit(node.extendsType, scopes);

      const inferScope = new Set<string>();

      collectInferTypeNames(node.extendsType, inferScope);
      visit(node.trueType, inferScope.size > 0 ? [...scopes, inferScope] : scopes);
      visit(node.falseType, scopes);
      return;
    }

    if (ts.isBlock(node)) {
      visitNodeList(Array.from(node.statements), scopes);
      return;
    }

    ts.forEachChild(node, (child) => visit(child, scopes));
  };

  const visitNodeList = (list: readonly ts.Node[], scopes: readonly Set<string>[]) => {
    const scope = new Set<string>();

    for (const node of list) {
      collectDirectBindingNames(node, scope, collectName);
    }

    const nextScopes = [...scopes, scope];

    for (const node of list) {
      visit(node, nextScopes);
    }
  };

  visitNodeList(nodes, []);
}

function isNameBound(
  name: string,
  scopes: readonly Set<string>[],
): boolean {
  return scopes.some((scope) => scope.has(name));
}

function isFunctionLikeWithBody(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    Boolean(node.body)
  );
}

export function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (!parent) {
    return true;
  }

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }

  if (ts.isTypeReferenceNode(parent) && parent.typeName === node) {
    return false;
  }

  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }

  if (ts.isShorthandPropertyAssignment(parent)) {
    return true;
  }

  if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent)) {
    return false;
  }

  if (ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) {
    return false;
  }

  if (ts.isTypeParameterDeclaration(parent)) {
    return false;
  }

  if (
    ts.isTypeAliasDeclaration(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isEnumDeclaration(parent)
  ) {
    return false;
  }

  if (
    (ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }

  if (ts.isInferTypeNode(parent)) {
    return false;
  }

  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
    return false;
  }

  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) {
    return false;
  }

  return true;
}

export function isBindingName(node: ts.Node): node is ts.BindingName {
  return (
    ts.isIdentifier(node) ||
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node)
  );
}

function collectInferTypeNames(node: ts.Node, names: Set<string>) {
  if (ts.isInferTypeNode(node)) {
    names.add(node.typeParameter.name.text);
    return;
  }

  ts.forEachChild(node, (child) => collectInferTypeNames(child, names));
}

function typeReferenceIdentifier(
  node: ts.TypeReferenceNode,
): ts.Identifier | undefined {
  return ts.isIdentifier(node.typeName) ? node.typeName : undefined;
}
