import * as ts from "typescript";
import {collectLocalBindings} from "./binder.ts";
import {printExpression, printNode} from "./ast-print.ts";
import type {
  CodeValue,
  Diagnostic,
  FragmentKind,
  ParsedFragment,
  SpliceHole,
} from "./types.ts";

/** Result of expanding explicit splices and implicit unquotes. */
export type ExpansionResult = {
  diagnostics: Diagnostic[];
  values: Map<number, CodeValue>;
};

/** Expands parsed fragments using the known host code-valued bindings. */
export function expandFragments(
  fragments: ParsedFragment[],
  codeBindings: Map<string, CodeValue>,
): ExpansionResult {
  const values = new Map<number, CodeValue>();
  const diagnostics: Diagnostic[] = [];

  for (const fragment of fragments) {
    values.set(fragment.quote.id, {
      kind: fragment.quote.kind,
      quote: fragment.quote,
      parsed: fragment,
    });
  }

  const expanding = new Set<number>();

  const expandValue = (value: CodeValue): CodeValue => {
    if (value.expandedNodes) {
      return value;
    }

    if (expanding.has(value.quote.id)) {
      diagnostics.push({
        code: "TSG1004",
        message: `recursive code binding '${value.quote.bindingName ?? "<anonymous>"}' cannot be implicitly unquoted`,
        origin: value.quote.origin,
      });
      value.expandedNodes = value.parsed.nodes;
      return value;
    }

    expanding.add(value.quote.id);
    const expanded = expandParsedFragment(value.parsed, codeBindings, values, expandValue);
    diagnostics.push(...expanded.diagnostics);
    value.expandedNodes = expanded.nodes;
    expanding.delete(value.quote.id);

    return value;
  };

  for (const value of values.values()) {
    expandValue(value);
  }

  return {diagnostics, values};
}

function expandParsedFragment(
  fragment: ParsedFragment,
  codeBindings: Map<string, CodeValue>,
  values: Map<number, CodeValue>,
  expandValue: (value: CodeValue) => CodeValue,
): {
  diagnostics: Diagnostic[];
  nodes: ts.Node[];
} {
  const diagnostics: Diagnostic[] = [];
  const locals = collectLocalBindings(fragment);
  const holes = new Map(fragment.quote.holes.map((hole) => [hole.placeholder, hole]));

  const expandSpliceExpression = (
    hole: SpliceHole,
    expected: FragmentKind,
  ): ts.Node[] | undefined => {
    const value = codeValueForExpression(hole.expression, codeBindings, values);

    if (!value) {
      diagnostics.push({
        code: "TSG1001",
        message: `explicit splice '${hole.expression.getText()}' does not resolve to a TypeStage code value`,
        origin: hole.origin,
      });
      return undefined;
    }

    const expanded = expandValue(value);

    if (!isCompatible(expanded.kind, expected)) {
      diagnostics.push({
        code: "TSG1002",
        message: `cannot splice ${expanded.kind} code into ${expected} position`,
        origin: hole.origin,
      });
      return undefined;
    }

    return expanded.expandedNodes ?? expanded.parsed.nodes;
  };

  const expandedNodes = fragment.nodes
    .flatMap((node) => {
      const transformed = transformNode(node, (candidate) => {
        if (
          ts.isExpressionStatement(candidate) &&
          ts.isIdentifier(candidate.expression)
        ) {
          const hole = holes.get(candidate.expression.text);

          if (hole) {
            return expandSpliceExpression(hole, "stmt") ?? candidate;
          }
        }

        if (ts.isIdentifier(candidate)) {
          const hole = holes.get(candidate.text);

          if (hole) {
            const replacement = expandSpliceExpression(hole, "expr")?.[0];

            return replacement && ts.isExpression(replacement)
              ? parenthesizeIfNeeded(replacement)
              : candidate;
          }

          const binding = codeBindings.get(candidate.text);

          if (
            binding &&
            binding.quote.id !== fragment.quote.id &&
            binding.kind === "expr" &&
            !locals.has(candidate.text) &&
            isReferenceIdentifier(candidate)
          ) {
            const expanded = expandValue(binding);
            const replacement = expanded.expandedNodes?.[0];

            return replacement && ts.isExpression(replacement)
              ? parenthesizeIfNeeded(replacement)
              : candidate;
          }
        }

        return candidate;
      });

      return Array.isArray(transformed) ? transformed : [transformed];
    })
    .filter((node): node is ts.Node => Boolean(node));

  return {diagnostics, nodes: expandedNodes};
}

function codeValueForExpression(
  expression: ts.Expression,
  codeBindings: Map<string, CodeValue>,
  values: Map<number, CodeValue>,
): CodeValue | undefined {
  if (ts.isIdentifier(expression)) {
    return codeBindings.get(expression.text);
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    for (const value of values.values()) {
      if (value.quote.node === expression) {
        return value;
      }
    }
  }

  return undefined;
}

function isCompatible(actual: FragmentKind, expected: FragmentKind): boolean {
  if (actual === expected) {
    return true;
  }

  return expected === "stmt" && (actual === "block" || actual === "decl");
}

function parenthesizeIfNeeded(expression: ts.Expression): ts.Expression {
  if (
    ts.isIdentifier(expression) ||
    ts.isLiteralExpression(expression) ||
    ts.isCallExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return expression;
  }

  return ts.factory.createParenthesizedExpression(expression);
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (!parent) {
    return true;
  }

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
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

  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
    return false;
  }

  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) {
    return false;
  }

  return true;
}

/** Prints the expanded source text for a TypeStage code value. */
export function codeValueText(value: CodeValue): string {
  const nodes = value.expandedNodes ?? value.parsed.nodes;

  if (value.kind === "expr") {
    const expression = nodes[0];

    return expression && ts.isExpression(expression)
      ? printExpression(expression)
      : value.parsed.source;
  }

  return nodes.map(printNode).join("\n");
}

function transformNode(
  node: ts.Node,
  replace: (node: ts.Node) => ts.VisitResult<ts.Node>,
): ts.VisitResult<ts.Node> {
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (candidate: ts.Node): ts.VisitResult<ts.Node> => {
        const replaced = replace(candidate);

        if (!replaced) {
          return candidate;
        }

        if (isNodeArrayResult(replaced)) {
          return replaced;
        }

        return ts.visitEachChild(replaced, visit, context);
      };

      return (root) => ts.visitNode(root, visit) ?? root;
    },
  ]);
  const result = transformed.transformed[0] ?? node;

  transformed.dispose();

  return synthesizeNode(result);
}

function synthesizeNode(node: ts.Node): ts.Node {
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (candidate: ts.Node): ts.Node => {
        const cloned = cloneNode(candidate);

        ts.setTextRange(cloned, {pos: -1, end: -1});

        return ts.visitEachChild(cloned, visit, context);
      };

      return (root) => ts.visitNode(root, visit) ?? root;
    },
  ]);
  const result = transformed.transformed[0] ?? node;

  transformed.dispose();

  return result;
}

function isNodeArrayResult(
  value: ts.VisitResult<ts.Node>,
): value is readonly ts.Node[] {
  return Array.isArray(value);
}

function cloneNode<T extends ts.Node>(node: T): T {
  const factory = ts.factory as typeof ts.factory & {
    cloneNode<NodeType extends ts.Node>(node: NodeType): NodeType;
  };

  return factory.cloneNode(node);
}
