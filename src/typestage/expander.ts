/**
 * Quote expansion and hygiene engine.
 * It resolves explicit splices, implicit code-valued references, persistent
 * runtime values, and local-name collision avoidance after quote bodies have
 * been parsed into TypeScript AST fragments.
 */
import * as ts from "typescript";
import {collectLocalBindings} from "./binder.ts";
import {printExpressionList, printNode} from "./ast-print.ts";
import {copyNodeOrigin, getNodeOrigin, setNodeOrigin, setTreeOrigin} from "./origin.ts";
import {persistValueToExpression} from "./persistence.ts";
import {isRuntimeCode, type RuntimeCode} from "./runtime.ts";
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

type CodeBindingResolver = (fragment: ParsedFragment) => Map<string, CodeValue>;

type Replacement = ts.VisitResult<ts.Node> | {
  node: ts.Node;
  skipChildren: true;
};

/** Expands parsed fragments using the known host code-valued bindings. */
export function expandFragments(
  fragments: ParsedFragment[],
  codeBindings: Map<string, CodeValue> | CodeBindingResolver,
  capturedValues: Map<number, unknown[]> = new Map(),
): ExpansionResult {
  const values = new Map<number, CodeValue>();
  const diagnostics: Diagnostic[] = [];
  const bindingResolver =
    codeBindings instanceof Map ? () => codeBindings : codeBindings;

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
      bindingResolver(value.parsed),
      capturedValues,
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
  capturedValues: Map<number, unknown[]>,
  values: Map<number, CodeValue>,
  expandValue: (value: CodeValue) => CodeValue,
  isExpanding: (value: CodeValue) => boolean,
): {
  diagnostics: Diagnostic[];
  nodes: ts.Node[];
} {
  const diagnostics: Diagnostic[] = [];
  annotateFragmentNodeOrigins(fragment);
  const initialLocals = collectLocalBindings(fragment);
  const captureRenames = captureAvoidanceRenames(
    fragment,
    initialLocals,
    codeBindings,
    values,
  );
  const sourceNodes =
    captureRenames.size > 0
      ? renameIdentifiers(fragment.nodes, captureRenames)
      : fragment.nodes;
  const renamedFragment =
    sourceNodes === fragment.nodes ? fragment : {...fragment, nodes: sourceNodes};
  const locals = collectLocalBindings(renamedFragment);
  const occupiedLocalNames = new Set(locals);
  const usedIdentifierNames = allIdentifierNames(sourceNodes);
  const holes = new Map(fragment.quote.holes.map((hole) => [hole.placeholder, hole]));

  const expandSpliceExpression = (
    hole: SpliceHole,
    expected: FragmentKind,
    expectedCardinality: QuoteCardinality = "one",
  ): ts.Node[] | undefined => {
    const value = codeValueForExpression(hole.expression, codeBindings, values);

    if (value) {
      return expandCodeValue(value, expected, expectedCardinality, hole.origin);
    }

    const captured = capturedValueForHole(fragment, hole, capturedValues);

    if (captured.found) {
      return expandCapturedValue(
        captured.value,
        expected,
        expectedCardinality,
        hole,
      );
    }

    diagnostics.push({
      code: "TSG1001",
      message: `explicit splice '${hole.expression.getText()}' does not resolve to a TypeStage code value`,
      origin: hole.origin,
    });
    return undefined;
  };

  const expandCapturedValue = (
    value: unknown,
    expected: FragmentKind,
    expectedCardinality: QuoteCardinality,
    hole: SpliceHole,
  ): ts.Node[] | undefined => {
    if (isRuntimeCode(value)) {
      const codeValue = codeValueForRuntimeCode(value, values);

      if (codeValue) {
        return expandCodeValue(codeValue, expected, expectedCardinality, hole.origin);
      }

      diagnostics.push({
        code: "TSG1001",
        message: `runtime code splice '${hole.expression.getText()}' does not resolve to a static TypeStage quote`,
        origin: hole.origin,
      });
      return undefined;
    }

    if (expected !== "expr") {
      diagnostics.push({
        code: "TSG1002",
        message: `cannot splice persistent value '${hole.expression.getText()}' into ${expected} position`,
        origin: hole.origin,
      });
      return undefined;
    }

    const persisted = persistValueToExpression(value);

    if (!persisted.ok) {
      diagnostics.push({
        code: "TSG1005",
        message: `persistent splice '${hole.expression.getText()}' is unsupported: ${persisted.message}`,
        origin: hole.origin,
      });
      return undefined;
    }

    return hygienicReplacementNodes([setTreeOrigin(persisted.expression, hole.origin)]);
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

    if (expanded.kind === "ident") {
      const replacements = identifierReplacementNodes(expandedNodes, expected);

      if (replacements) {
        return hygienicReplacementNodes(replacements);
      }
    }

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
        return hygienicReplacementNodes(replacements);
      }

      if (replacements.length === 1) {
        return hygienicReplacementNodes(replacements);
      }

      diagnostics.push({
        code: "TSG1002",
        message: `cannot splice ${replacements.length} ${expanded.kind} nodes into ${expected} position`,
        origin,
      });
      return undefined;
    }

    if (expected === "expr" && expanded.kind === "block") {
      const adapted = adaptBlockToExpression(expandedNodes, origin);

      if (!adapted.ok) {
        diagnostics.push({
          code: "TSG1003",
          message: adapted.message,
          origin,
        });
        return undefined;
      }

      return hygienicReplacementNodes([adapted.expression]);
    }

    if (!isCompatible(expanded.kind, expected)) {
      diagnostics.push({
        code: "TSG1002",
        message: `cannot splice ${expanded.kind} code into ${expected} position`,
        origin,
      });
      return undefined;
    }

    return hygienicReplacementNodes(expandedNodes);
  };

  const hygienicReplacementNodes = (nodes: ts.Node[]): ts.Node[] => {
    const localNames = localBindingNames(nodes);
    const conflicts = Array.from(localNames)
      .filter((name) => occupiedLocalNames.has(name))
      .sort();
    const used = new Set([...usedIdentifierNames, ...allIdentifierNames(nodes)]);
    let result = nodes;

    if (conflicts.length > 0) {
      const renames = new Map<string, string>();

      for (const name of conflicts) {
        renames.set(name, freshIdentifierName(name, used));
      }

      result = renameIdentifiers(nodes, renames);
    }

    for (const name of localBindingNames(result)) {
      occupiedLocalNames.add(name);
    }

    for (const name of allIdentifierNames(result)) {
      usedIdentifierNames.add(name);
    }

    return result;
  };

  const expandedNodes = sourceNodes
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

  annotateFragmentNodeOrigins({...fragment, nodes: expandedNodes});

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

function capturedValueForHole(
  fragment: ParsedFragment,
  hole: SpliceHole,
  capturedValues: Map<number, unknown[]>,
): {
  found: true;
  value: unknown;
} | {
  found: false;
} {
  const values = capturedValues.get(fragment.quote.id);

  return values && hole.index < values.length
    ? {found: true, value: values[hole.index]}
    : {found: false};
}

function codeValueForRuntimeCode(
  value: RuntimeCode,
  values: Map<number, CodeValue>,
): CodeValue | undefined {
  return value.quoteId === undefined ? undefined : values.get(value.quoteId);
}

function captureAvoidanceRenames(
  fragment: ParsedFragment,
  locals: Set<string>,
  codeBindings: Map<string, CodeValue>,
  values: Map<number, CodeValue>,
): Map<string, string> {
  const introduced = new Set<string>();

  for (const value of referencedCodeValues(fragment, locals, codeBindings, values)) {
    for (const name of freeReferenceNames(value.expandedNodes ?? value.parsed.nodes)) {
      introduced.add(name);
    }
  }

  const conflicts = Array.from(introduced)
    .filter((name) => locals.has(name))
    .sort();

  if (conflicts.length === 0) {
    return new Map();
  }

  const used = allIdentifierNames(fragment.nodes);
  const renames = new Map<string, string>();

  for (const name of conflicts) {
    renames.set(name, freshIdentifierName(name, used));
  }

  return renames;
}

function referencedCodeValues(
  fragment: ParsedFragment,
  locals: Set<string>,
  codeBindings: Map<string, CodeValue>,
  values: Map<number, CodeValue>,
): Set<CodeValue> {
  const referenced = new Set<CodeValue>();

  for (const hole of fragment.quote.holes) {
    const value = codeValueForExpression(hole.expression, codeBindings, values);

    if (value) {
      referenced.add(value);
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const binding = codeBindings.get(node.text);

      if (
        binding &&
        binding.quote.id !== fragment.quote.id &&
        syntaxFamilyForKind(binding.kind) === "expr" &&
        !locals.has(node.text) &&
        isReferenceIdentifier(node)
      ) {
        referenced.add(binding);
      }
    }

    ts.forEachChild(node, visit);
  };

  for (const node of fragment.nodes) {
    visit(node);
  }

  return referenced;
}

function freeReferenceNames(nodes: ts.Node[]): Set<string> {
  const locals = localBindingNames(nodes);
  const free = new Set<string>();

  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      isReferenceIdentifier(node) &&
      !locals.has(node.text)
    ) {
      free.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  for (const node of nodes) {
    visit(node);
  }

  return free;
}

function localBindingNames(nodes: ts.Node[]): Set<string> {
  const names = new Set<string>();

  for (const node of nodes) {
    collectBindingNames(node, names);
  }

  return names;
}

function collectBindingNames(node: ts.Node, names: Set<string>) {
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

  ts.forEachChild(node, (child) => collectBindingNames(child, names));
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

function allIdentifierNames(nodes: ts.Node[]): Set<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  for (const node of nodes) {
    visit(node);
  }

  return names;
}

function freshIdentifierName(base: string, used: Set<string>): string {
  let suffix = 1;
  let candidate = `${base}_${suffix}`;

  while (used.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }

  used.add(candidate);

  return candidate;
}

function renameIdentifiers(nodes: ts.Node[], renames: Map<string, string>): ts.Node[] {
  return nodes.map((node) => {
    const renamed = transformNode(node, (candidate) => {
      if (
        ts.isIdentifier(candidate) &&
        shouldRenameIdentifier(candidate, renames)
      ) {
        return completedReplacement(
          copyNodeOrigin(
            ts.factory.createIdentifier(renames.get(candidate.text)!),
            candidate,
          ),
        );
      }

      return candidate;
    });

    return Array.isArray(renamed) ? renamed[0] ?? node : renamed;
  });
}

function shouldRenameIdentifier(
  node: ts.Identifier,
  renames: Map<string, string>,
): boolean {
  return (
    renames.has(node.text) &&
    (isReferenceIdentifier(node) || isBindingIdentifier(node))
  );
}

function isBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (!parent) {
    return false;
  }

  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node)
  );
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

    case "ident":
      return undefined;

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

function identifierReplacementNodes(
  nodes: ts.Node[],
  expected: FragmentKind,
): ts.Node[] | undefined {
  if (nodes.length !== 1) {
    return undefined;
  }

  const identifier = nodes[0];

  if (!identifier || !ts.isIdentifier(identifier)) {
    return undefined;
  }

  switch (expected) {
    case "expr":
    case "ident":
    case "pattern":
      return [identifier];

    case "type":
      return [
        setTreeOrigin(
          ts.factory.createTypeReferenceNode(identifier.text),
          getNodeOrigin(identifier) ?? {
            sourceFile: identifier.getSourceFile().fileName,
            start: identifier.getStart(),
            end: identifier.getEnd(),
          },
        ),
      ];

    case "stmt":
    case "block":
    case "decl":
      return undefined;
  }
}

function isExpressionListPosition(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (!parent) {
    return false;
  }

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

function adaptBlockToExpression(nodes: ts.Node[], origin: Origin): {
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
  setNodeOrigin(arrow, origin);

  return {
    ok: true,
    expression: setTreeOrigin(
      ts.factory.createCallExpression(
        ts.factory.createParenthesizedExpression(arrow),
        undefined,
        [],
      ),
      origin,
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

  return copyNodeOrigin(factory.cloneNode(node), node);
}

function annotateFragmentNodeOrigins(fragment: ParsedFragment) {
  const visit = (node: ts.Node) => {
    if (!getNodeOrigin(node) && node.pos >= 0 && node.end >= 0) {
      setNodeOrigin(node, originForNode(fragment, node));
    }

    ts.forEachChild(node, visit);
  };

  for (const node of fragment.nodes) {
    visit(node);
  }
}
