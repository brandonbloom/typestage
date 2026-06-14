import * as ts from "typescript";
import {collectLocalBindings} from "./binder.ts";
import {printExpressionList, printNode} from "./ast-print.ts";
import type {
  CodeValue,
  Diagnostic,
  FragmentKind,
  Origin,
  ParsedFragment,
  QuoteCardinality,
  SpliceHole,
} from "./types.ts";

/** Result of expanding explicit splices and implicit unquotes. */
export type ExpansionResult = {
  diagnostics: Diagnostic[];
  values: Map<number, CodeValue>;
};

type Replacement = ts.VisitResult<ts.Node> | {
  node: ts.Node;
  skipChildren: true;
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
      cardinality: fragment.quote.cardinality,
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
    const expanded = expandParsedFragment(
      value.parsed,
      codeBindings,
      values,
      expandValue,
      (candidate) => expanding.has(candidate.quote.id),
    );
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
  isExpanding: (value: CodeValue) => boolean,
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
    expectedCardinality: QuoteCardinality = "one",
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

    return expandCodeValue(value, expected, expectedCardinality, hole.origin);
  };

  const expandCodeValue = (
    value: CodeValue,
    expected: FragmentKind,
    expectedCardinality: QuoteCardinality,
    origin: Origin,
  ): ts.Node[] | undefined => {
    if (isExpanding(value)) {
      expandValue(value);
      return undefined;
    }

    const expanded = expandValue(value);
    const expandedNodes = expanded.expandedNodes ?? expanded.parsed.nodes;
    const expectedFamily = syntaxFamilyForKind(expected);
    const actualFamily = syntaxFamilyForKind(expanded.kind);

    if (expectedFamily && expectedFamily === actualFamily) {
      const replacements = syntaxSequenceNodes(
        expanded.kind,
        expanded.cardinality,
        expandedNodes,
      );

      if (!replacements) {
        return undefined;
      }

      if (expectedCardinality === "many") {
        return replacements;
      }

      if (replacements.length === 1) {
        return replacements;
      }

      diagnostics.push({
        code: "TSG1002",
        message: `cannot splice ${replacements.length} ${expanded.kind} nodes into ${expected} position`,
        origin,
      });
      return undefined;
    }

    if (expected === "expr" && expanded.kind === "block") {
      const adapted = adaptBlockToExpression(expandedNodes);

      if (!adapted.ok) {
        diagnostics.push({
          code: "TSG1003",
          message: adapted.message,
          origin,
        });
        return undefined;
      }

      return [adapted.expression];
    }

    if (!isCompatible(expanded.kind, expected)) {
      diagnostics.push({
        code: "TSG1002",
        message: `cannot splice ${expanded.kind} code into ${expected} position`,
        origin,
      });
      return undefined;
    }

    return expandedNodes;
  };

  const expandedNodes = fragment.nodes
    .flatMap((node) => {
      const transformed = transformNode(node, (candidate) => {
        if (ts.isTypeReferenceNode(candidate)) {
          const name = typeReferenceIdentifier(candidate);

          if (name) {
            const hole = holes.get(name.text);
            const expectedCardinality = isTypeListPosition(candidate) ? "many" : "one";

            if (hole) {
              const replacements = expandSpliceExpression(
                hole,
                "type",
                expectedCardinality,
              );

              return typeReplacementResult(expectedCardinality, replacements) ??
                completedReplacement(candidate);
            }

            const binding = codeBindings.get(name.text);

            if (
              binding &&
              binding.quote.id !== fragment.quote.id &&
              syntaxFamilyForKind(binding.kind) === "type"
            ) {
              const replacements = expandCodeValue(
                binding,
                "type",
                expectedCardinality,
                originForNode(fragment, candidate),
              );

              return typeReplacementResult(expectedCardinality, replacements) ?? candidate;
            }
          }
        }

        if (ts.isParameter(candidate) && ts.isIdentifier(candidate.name)) {
          const hole = holes.get(candidate.name.text);

          if (hole) {
            const replacements = expandSpliceExpression(hole, "pattern", "many");
            const bindingNames = bindingNameReplacements(replacements);

            return bindingNames
              ? bindingNames.map((name) => cloneParameterWithName(candidate, name))
              : completedReplacement(candidate);
          }
        }

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
            if (isExpressionListPosition(candidate)) {
              const replacements = expandSpliceExpression(hole, "expr", "many");

              return replacements && replacements.every(ts.isExpression)
                ? replacements
                : candidate;
            }

            const replacement = expandSpliceExpression(hole, "expr")?.[0];

            return replacement && ts.isExpression(replacement)
              ? completedReplacement(parenthesizeIfNeeded(replacement))
              : candidate;
          }

          const binding = codeBindings.get(candidate.text);

          if (
            binding &&
            binding.quote.id !== fragment.quote.id &&
            syntaxFamilyForKind(binding.kind) === "expr" &&
            !locals.has(candidate.text) &&
            isReferenceIdentifier(candidate)
          ) {
            if (isExpressionListPosition(candidate)) {
              const replacements = expandCodeValue(
                binding,
                "expr",
                "many",
                originForNode(fragment, candidate),
              );

              return replacements && replacements.every(ts.isExpression)
                ? replacements
                : candidate;
            }

            const replacement = expandCodeValue(
              binding,
              "expr",
              "one",
              originForNode(fragment, candidate),
            )?.[0];

            return replacement && ts.isExpression(replacement)
              ? completedReplacement(parenthesizeIfNeeded(replacement))
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

type SyntaxFamily = "expr" | "type" | "pattern";

function syntaxFamilyForKind(kind: FragmentKind): SyntaxFamily | undefined {
  switch (kind) {
    case "expr":
      return "expr";

    case "type":
      return "type";

    case "pattern":
      return "pattern";

    case "stmt":
    case "block":
    case "decl":
      return undefined;
  }
}

function isExpressionListPosition(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (ts.isCallExpression(parent)) {
    return parent.arguments.some((argument) => argument === node);
  }

  if (ts.isNewExpression(parent)) {
    return parent.arguments?.some((argument) => argument === node) ?? false;
  }

  return false;
}

function syntaxSequenceNodes(
  kind: FragmentKind,
  cardinality: QuoteCardinality,
  nodes: ts.Node[],
): ts.Node[] | undefined {
  const family = syntaxFamilyForKind(kind);

  if (!family) {
    return undefined;
  }

  const replacements: ts.Node[] = [];

  for (const node of nodes) {
    switch (family) {
      case "expr":
        if (!ts.isExpression(node)) {
          return undefined;
        }

        replacements.push(
          cardinality === "one" ? unwrapExpressionListElement(node) : node,
        );
        break;

      case "type":
        if (!ts.isTypeNode(node)) {
          return undefined;
        }

        replacements.push(node);
        break;

      case "pattern":
        if (!isBindingName(node)) {
          return undefined;
        }

        replacements.push(node);
        break;
    }
  }

  return replacements;
}

function unwrapExpressionListElement(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression)
    ? expression.expression
    : expression;
}

function typeReferenceIdentifier(node: ts.TypeReferenceNode): ts.Identifier | undefined {
  return ts.isIdentifier(node.typeName) && !node.typeArguments
    ? node.typeName
    : undefined;
}

function isTypeListPosition(node: ts.TypeReferenceNode): boolean {
  const parent = node.parent;

  if (ts.isTypeReferenceNode(parent)) {
    return parent.typeArguments?.some((type) => type === node) ?? false;
  }

  if (ts.isTupleTypeNode(parent)) {
    return parent.elements.some((element) => element === node);
  }

  return false;
}

function typeReplacements(nodes: ts.Node[] | undefined): ts.TypeNode[] | undefined {
  return nodes?.every(ts.isTypeNode) ? nodes : undefined;
}

function typeReplacementResult(
  expectedCardinality: QuoteCardinality,
  nodes: ts.Node[] | undefined,
): Replacement | undefined {
  const replacements = typeReplacements(nodes);

  if (!replacements) {
    return undefined;
  }

  if (expectedCardinality === "many") {
    return replacements;
  }

  const replacement = replacements[0];

  return replacement ? completedReplacement(replacement) : undefined;
}

function bindingNameReplacements(
  nodes: ts.Node[] | undefined,
): ts.BindingName[] | undefined {
  return nodes?.every(isBindingName) ? nodes : undefined;
}

function isBindingName(node: ts.Node): node is ts.BindingName {
  return (
    ts.isIdentifier(node) ||
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node)
  );
}

function cloneParameterWithName(
  parameter: ts.ParameterDeclaration,
  name: ts.BindingName,
): ts.ParameterDeclaration {
  return ts.factory.updateParameterDeclaration(
    parameter,
    ts.getModifiers(parameter),
    parameter.dotDotDotToken,
    name,
    parameter.questionToken,
    parameter.type,
    parameter.initializer,
  );
}

function originForNode(fragment: ParsedFragment, node: ts.Node): Origin {
  const start = Math.max(
    0,
    node.getStart(fragment.sourceFile) - fragment.fragmentStart,
  );
  const end = Math.max(start + 1, node.getEnd() - fragment.fragmentStart);
  const last = Math.max(0, fragment.originMap.length - 1);
  const startOrigin = fragment.originMap[Math.min(start, last)];
  const endOrigin = fragment.originMap[Math.min(end - 1, last)];

  if (
    startOrigin &&
    endOrigin &&
    startOrigin.sourceFile === endOrigin.sourceFile
  ) {
    return {
      sourceFile: startOrigin.sourceFile,
      start: startOrigin.start,
      end: endOrigin.end,
    };
  }

  return startOrigin ?? fragment.quote.origin;
}

function adaptBlockToExpression(nodes: ts.Node[]): {
  expression: ts.Expression;
  ok: true;
} | {
  message: string;
  ok: false;
} {
  const statements = blockStatements(nodes);

  if (containsUnsafeBlockAdapterSyntax(statements)) {
    return {
      ok: false,
      message: "cannot adapt block containing break, continue, yield, or await into expression position",
    };
  }

  const arrow = ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    ts.factory.createBlock(statements, true),
  );

  return {
    ok: true,
    expression: ts.factory.createCallExpression(
      ts.factory.createParenthesizedExpression(arrow),
      undefined,
      [],
    ),
  };
}

function blockStatements(nodes: ts.Node[]): ts.Statement[] {
  const onlyNode = nodes[0];

  if (nodes.length === 1 && onlyNode && ts.isBlock(onlyNode)) {
    return Array.from(onlyNode.statements);
  }

  return nodes.filter(ts.isStatement);
}

function containsUnsafeBlockAdapterSyntax(nodes: readonly ts.Node[]): boolean {
  let unsafe = false;

  const visit = (node: ts.Node) => {
    if (
      ts.isBreakStatement(node) ||
      ts.isContinueStatement(node) ||
      ts.isYieldExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      unsafe = true;
      return;
    }

    ts.forEachChild(node, visit);
  };

  for (const node of nodes) {
    visit(node);

    if (unsafe) {
      return true;
    }
  }

  return false;
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
  const syntaxNodes = syntaxSequenceNodes(value.kind, value.cardinality, nodes);

  if (syntaxNodes) {
    return syntaxSequenceText(value.kind, syntaxNodes);
  }

  return nodes.map(printNode).join("\n");
}

function syntaxSequenceText(kind: FragmentKind, nodes: ts.Node[]): string {
  return syntaxFamilyForKind(kind) === "expr" && nodes.every(ts.isExpression)
    ? printExpressionList(nodes)
    : nodes.map(printNode).join(", ");
}

function transformNode(
  node: ts.Node,
  replace: (node: ts.Node) => Replacement,
): ts.VisitResult<ts.Node> {
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (candidate: ts.Node): ts.VisitResult<ts.Node> => {
        const replaced = replace(candidate);

        if (isCompletedReplacement(replaced)) {
          return replaced.node;
        }

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

function completedReplacement(node: ts.Node): Replacement {
  return {node, skipChildren: true};
}

function isCompletedReplacement(
  value: Replacement,
): value is {node: ts.Node; skipChildren: true} {
  return Boolean(
    value &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      "skipChildren" in value,
  );
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
