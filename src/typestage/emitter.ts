/**
 * Residual TypeScript emission for expanded code values.
 * Graph compilation uses these helpers so declaration quotes and exported
 * expression quotes print with one consistent policy across emitted modules.
 */
import * as ts from "typescript";
import {printExpressionList, printNode, printNodes} from "./ast-print.ts";
import {setNodeOrigin} from "./origin.ts";
import type {CodeValue} from "./types.ts";

/** Converts one expanded code value into residual module statements. */
export function moduleStatementsForValue(value: CodeValue): ts.Statement[] {
  const nodes = value.expandedNodes ?? value.parsed.nodes;

  if (value.kind === "decl") {
    return nodes.filter(ts.isStatement);
  }

  if (value.kind === "expr" && value.cardinality === "one" && value.quote.bindingName) {
    const expression = nodes[0];

    if (!expression || !ts.isExpression(expression)) {
      return [];
    }

    const bindingName = ts.factory.createIdentifier(value.quote.bindingName);

    if (value.quote.bindingNameOrigin) {
      setNodeOrigin(bindingName, value.quote.bindingNameOrigin);
    }

    return [
      ts.factory.createVariableStatement(
        [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              bindingName,
              undefined,
              undefined,
              expression,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
    ];
  }

  return nodes.filter(ts.isStatement);
}

/** Prints the expanded source text for snapshotting a TypeStage code value. */
export function printCodeValue(value: CodeValue): string {
  const nodes = value.expandedNodes ?? value.parsed.nodes;
  const syntaxNodes = syntaxSequenceNodes(value.kind, value.cardinality, nodes);

  if (syntaxNodes) {
    return syntaxSequenceText(value.kind, syntaxNodes);
  }

  return printNodes(nodes.filter(ts.isStatement));
}

function syntaxSequenceNodes(
  kind: CodeValue["kind"],
  cardinality: CodeValue["cardinality"],
  nodes: ts.Node[],
): ts.Node[] | undefined {
  const syntaxNodes: ts.Node[] = [];

  for (const node of nodes) {
    switch (kind) {
      case "expr":
        if (!ts.isExpression(node)) {
          return undefined;
        }

        syntaxNodes.push(cardinality === "one" ? unwrapExpressionListElement(node) : node);
        break;

      case "ident":
        if (!ts.isIdentifier(node)) {
          return undefined;
        }

        syntaxNodes.push(node);
        break;

      case "type":
        if (!ts.isTypeNode(node)) {
          return undefined;
        }

        syntaxNodes.push(node);
        break;

      case "pattern":
        if (!isBindingName(node)) {
          return undefined;
        }

        syntaxNodes.push(node);
        break;

      case "stmt":
      case "block":
      case "decl":
        return undefined;
    }
  }

  return syntaxNodes;
}

function syntaxSequenceText(kind: CodeValue["kind"], nodes: ts.Node[]): string {
  return kind === "expr" && nodes.every(ts.isExpression)
    ? printExpressionList(nodes)
    : nodes.map(printNode).join(", ");
}

function unwrapExpressionListElement(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression)
    ? expression.expression
    : expression;
}

function isBindingName(node: ts.Node): node is ts.BindingName {
  return (
    ts.isIdentifier(node) ||
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node)
  );
}
