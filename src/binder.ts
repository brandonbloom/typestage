import * as ts from "typescript";
import type {CodeValue, ParsedFragment, PersistentBinding} from "./types.ts";

/** Snapshot-friendly summary of code-valued and residual bindings. */
export type BindingSummary = {
  codeBindings: Array<{
    name: string;
    kind: CodeValue["kind"];
    quoteId: number;
  }>;
  localBindingsByQuote: Array<{
    quoteId: number;
    names: string[];
  }>;
};

/** Builds host bindings known to contain TypeStage code values. */
export function buildCodeBindings(
  fragments: ParsedFragment[],
): Map<string, CodeValue> {
  const bindings = new Map<string, CodeValue>();

  for (const fragment of fragments) {
    const name = fragment.quote.bindingName;

    if (!name) {
      continue;
    }

    bindings.set(name, {
      cardinality: fragment.quote.cardinality,
      kind: fragment.quote.kind,
      quote: fragment.quote,
      parsed: fragment,
    });
  }

  return bindings;
}

/** Builds host const bindings available for multi-stage persistence. */
export function buildPersistentBindings(
  sourceFile: ts.SourceFile,
): Map<string, PersistentBinding> {
  const bindings = new Map<string, PersistentBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }

      // Keep unsupported consts resolvable so structured persistence has a
      // single extension point after the design is settled.
      bindings.set(declaration.name.text, {
        name: declaration.name.text,
        initializer: declaration.initializer,
        persistence: isPrimitivePersistentExpression(declaration.initializer)
          ? "primitive"
          : "unsupported",
      });
    }
  }

  return bindings;
}

/** Collects syntactic names declared inside a parsed residual fragment. */
export function collectLocalBindings(fragment: ParsedFragment): Set<string> {
  const names = new Set<string>();

  for (const node of fragment.nodes) {
    collectBindingsInNode(node, names);
  }

  return names;
}

function isPrimitivePersistentExpression(expression: ts.Expression): boolean {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    ts.isBigIntLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }

  if (ts.isPrefixUnaryExpression(expression)) {
    return (
      (expression.operator === ts.SyntaxKind.MinusToken ||
        expression.operator === ts.SyntaxKind.PlusToken) &&
      (ts.isNumericLiteral(expression.operand) ||
        ts.isBigIntLiteral(expression.operand))
    );
  }

  return false;
}

/** Produces a stable binding summary for diagnostics and fixture output. */
export function summarizeBindings(
  fragments: ParsedFragment[],
  codeBindings: Map<string, CodeValue>,
): BindingSummary {
  return {
    codeBindings: Array.from(codeBindings.entries())
      .map(([name, value]) => ({
        name,
        kind: value.kind,
        quoteId: value.quote.id,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    localBindingsByQuote: fragments.map((fragment) => ({
      quoteId: fragment.quote.id,
      names: Array.from(collectLocalBindings(fragment)).sort(),
    })),
  };
}

function collectBindingsInNode(node: ts.Node, names: Set<string>) {
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

function collectBindingName(name: ts.BindingName, names: Set<string>) {
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
