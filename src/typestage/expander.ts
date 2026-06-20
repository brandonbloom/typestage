/**
 * Quote expansion and hygiene engine.
 * It resolves explicit splices, implicit code-valued references, persistent
 * runtime values, and local-name collision avoidance after quote bodies have
 * been parsed into TypeScript AST fragments.
 */
import * as ts from "typescript";
import {collectLocalBindings} from "./binder.ts";
import {printExpressionList, printNode} from "./ast-print.ts";
import {
  blockExpressionAdapterFailed,
  incompatibleSplice,
  persistentValueUnsupported,
  recursiveImplicitUnquote,
  unresolvedResidualReference,
} from "./diagnostics/index.ts";
import {copyNodeOrigin, getNodeOrigin, setNodeOrigin, setTreeOrigin} from "./origin.ts";
import {persistValueToExpression} from "./persistence.ts";
import {
  isBindingName,
  isReferenceIdentifier,
} from "./residual-scope.ts";
import {type SemanticContext} from "./semantic.ts";
import {
  capturedValueForHole,
  SpliceEvaluator,
  type SpliceValue,
} from "./splice-evaluator.ts";
import {
  allIdentifierNames,
  prepareSubstitutionRecipient,
  Substitution,
} from "./substitution.ts";
import {Environment, residualImportKey} from "./environment.ts";
import type {
  CodeValue,
  Diagnostic,
  FragmentKind,
  Origin,
  ParsedFragment,
  QuoteCardinality,
  ResidualImport,
  SpliceHole,
} from "./types.ts";

/** Result of expanding explicit splices and implicit unquotes. */
export type ExpansionResult = {
  diagnostics: Diagnostic[];
  values: Map<number, CodeValue>;
};

type CodeBindingResolver = (fragment: ParsedFragment) => Map<string, CodeValue>;
type ImportBindingResolver = (fragment: ParsedFragment) => Map<string, ResidualImport>;

type Replacement = ts.VisitResult<ts.Node> | {
  node: ts.Node;
  skipChildren: true;
};

type RewriteDecision =
  | {kind: "keep"}
  | {kind: "replace"; node: ts.Node; visitChildren: boolean}
  | {kind: "replaceMany"; nodes: ts.Node[]}
  | {kind: "failed"};

type SyntaxPosition = {
  kind: FragmentKind;
  cardinality: QuoteCardinality;
  origin: Origin;
};

type Placement = {
  placeCode(value: CodeValue, position: SyntaxPosition): ts.Node[] | undefined;
  placeHostValue(name: string, position: SyntaxPosition): ts.Expression | undefined;
  placeSplice(
    value: SpliceValue,
    position: SyntaxPosition,
    hole: SpliceHole,
  ): ts.Node[] | undefined;
};

/** Collects host value names that staging must capture before expansion. */
export function collectHostCaptureNames(
  fragments: ParsedFragment[],
  codeBindings: Map<string, CodeValue> | CodeBindingResolver,
  semantic?: SemanticContext,
  importBindings: Map<string, ResidualImport> | ImportBindingResolver = new Map(),
): {
  diagnostics: Diagnostic[];
  hostCaptureNames: Map<number, Set<string>>;
} {
  const bindingResolver =
    codeBindings instanceof Map ? () => codeBindings : codeBindings;
  const importResolver =
    importBindings instanceof Map ? () => importBindings : importBindings;
  const diagnostics: Diagnostic[] = [];
  const hostCaptureNames = new Map<number, Set<string>>();

  for (const fragment of fragments) {
    const environment = Environment.analyze(
      fragment,
      bindingResolver(fragment),
      semantic,
      importResolver(fragment),
    );

    diagnostics.push(...environment.diagnostics);

    const hostNames = environment.collectHostCaptures();

    if (hostNames.size > 0) {
      hostCaptureNames.set(fragment.quote.id, hostNames);
    }
  }

  return {diagnostics, hostCaptureNames};
}

/** Expands parsed fragments using the known host code-valued bindings. */
export function expandFragments(
  fragments: ParsedFragment[],
  codeBindings: Map<string, CodeValue> | CodeBindingResolver,
  capturedValues: Map<number, unknown[]> = new Map(),
  capturedHostValues: Map<number, Record<string, unknown>> = new Map(),
  semantic?: SemanticContext,
  importBindings: Map<string, ResidualImport> | ImportBindingResolver = new Map(),
): ExpansionResult {
  const values = new Map<number, CodeValue>();
  const diagnostics: Diagnostic[] = [];
  const bindingResolver =
    codeBindings instanceof Map ? () => codeBindings : codeBindings;
  const importResolver =
    importBindings instanceof Map ? () => importBindings : importBindings;
  const context = new ExpansionContext({
    bindingResolver,
    capturedHostValues,
    capturedValues,
    diagnostics,
    importResolver,
    semantic,
    values,
  });

  for (const fragment of fragments) {
    values.set(fragment.quote.id, {
      cardinality: fragment.quote.cardinality,
      kind: fragment.quote.kind,
      quote: fragment.quote,
      parsed: fragment,
    });
  }

  for (const value of values.values()) {
    if (shouldEagerlyExpand(value)) {
      context.expandValue(value);
    }
  }

  return {diagnostics, values};
}

function shouldEagerlyExpand(value: CodeValue): boolean {
  return Boolean(value.quote.bindingName || value.quote.exported);
}

class ExpansionContext {
  readonly bindingResolver: CodeBindingResolver;
  readonly capturedHostValues: Map<number, Record<string, unknown>>;
  readonly capturedValues: Map<number, unknown[]>;
  readonly diagnostics: Diagnostic[];
  readonly importResolver: ImportBindingResolver;
  readonly semantic: SemanticContext | undefined;
  readonly values: Map<number, CodeValue>;
  private readonly expanding = new Set<number>();

  constructor(options: {
    bindingResolver: CodeBindingResolver;
    capturedHostValues: Map<number, Record<string, unknown>>;
    capturedValues: Map<number, unknown[]>;
    diagnostics: Diagnostic[];
    importResolver: ImportBindingResolver;
    semantic: SemanticContext | undefined;
    values: Map<number, CodeValue>;
  }) {
    this.bindingResolver = options.bindingResolver;
    this.capturedHostValues = options.capturedHostValues;
    this.capturedValues = options.capturedValues;
    this.diagnostics = options.diagnostics;
    this.importResolver = options.importResolver;
    this.semantic = options.semantic;
    this.values = options.values;
  }

  codeBindings(fragment: ParsedFragment): Map<string, CodeValue> {
    return this.bindingResolver(fragment);
  }

  importBindings(fragment: ParsedFragment): Map<string, ResidualImport> {
    return this.importResolver(fragment);
  }

  isExpanding(value: CodeValue): boolean {
    return this.expanding.has(value.quote.id);
  }

  expandValue(value: CodeValue): CodeValue {
    if (value.expandedNodes) {
      return value;
    }

    if (this.expanding.has(value.quote.id)) {
      this.diagnostics.push({
        code: recursiveImplicitUnquote.code,
        message: `recursive code binding '${value.quote.bindingName ?? "<anonymous>"}' cannot be implicitly unquoted`,
        origin: value.quote.origin,
      });
      value.expandedNodes = value.parsed.nodes;
      return value;
    }

    this.expanding.add(value.quote.id);

    const expanded = expandFragmentBody(
      value.parsed,
      this,
      value.runtimeValues,
      value.runtimeHostValues,
    );

    this.diagnostics.push(...expanded.diagnostics);
    value.expandedNodes = expanded.nodes;
    value.residualImports = expanded.residualImports;
    this.expanding.delete(value.quote.id);

    return value;
  }
}

function expandFragmentBody(
  fragment: ParsedFragment,
  context: ExpansionContext,
  runtimeValues: unknown[] | undefined,
  runtimeHostValues: Record<string, unknown> | undefined,
): {
  diagnostics: Diagnostic[];
  nodes: ts.Node[];
  residualImports: ResidualImport[];
} {
  const diagnostics: Diagnostic[] = [];
  const codeBindings = context.codeBindings(fragment);
  const importBindings = context.importBindings(fragment);
  const values = context.values;
  annotateFragmentNodeOrigins(fragment);
  const initialLocals = collectLocalBindings(fragment);
  const sourceNodes = prepareSubstitutionRecipient({
    fragment,
    locals: initialLocals,
    codeBindings,
    values,
  });
  const renamedFragment =
    sourceNodes === fragment.nodes ? fragment : {...fragment, nodes: sourceNodes};
  const locals = collectLocalBindings(renamedFragment);
  const environment = Environment.analyze(
    renamedFragment,
    codeBindings,
    context.semantic,
    importBindings,
    {
      diagnoseUnresolved: true,
      originForNode: (node) => originForNode(renamedFragment, node),
    },
  );
  diagnostics.push(...environment.diagnostics);
  const residualImports = new Map(environment.residualImports);

  const addResidualImports = (imports: readonly ResidualImport[] | undefined) => {
    for (const residualImport of imports ?? []) {
      residualImports.set(residualImportKey(residualImport), residualImport);
    }
  };

  const substitution = new Substitution({
    occupiedNames: locals,
    usedNames: allIdentifierNames(sourceNodes),
  });
  const holes = new Map(fragment.quote.holes.map((hole) => [hole.placeholder, hole]));
  const spliceEvaluator = new SpliceEvaluator(
    context,
    fragment,
    codeBindings,
    runtimeValues,
    diagnostics,
  );

  const expandSpliceExpression = (
    hole: SpliceHole,
    expected: FragmentKind,
    expectedCardinality: QuoteCardinality = "one",
  ): ts.Node[] | undefined => {
    return placement.placeSplice(
      spliceEvaluator.evaluateSplice(hole),
      {
        cardinality: expectedCardinality,
        kind: expected,
        origin: hole.origin,
      },
      hole,
    );
  };

  const placeSpliceValue = (
    value: SpliceValue,
    position: SyntaxPosition,
    hole: SpliceHole,
  ): ts.Node[] | undefined => {
    if (value.kind === "missing") {
      return undefined;
    }

    if (value.kind === "code") {
      return expandCodeValues(value.values, position, hole);
    }

    if (position.kind !== "expr") {
      diagnostics.push({
        code: incompatibleSplice.code,
        message: `cannot splice persistent value '${hole.expression.getText()}' into ${position.kind} position`,
        origin: hole.origin,
      });
      return undefined;
    }

    const persisted = persistValueToExpression(value.value);

    if (!persisted.ok) {
      diagnostics.push({
        code: persistentValueUnsupported.code,
        message: `persistent splice '${hole.expression.getText()}' is unsupported: ${persisted.message}`,
        origin: hole.origin,
      });
      return undefined;
    }

    return substitution.apply([setTreeOrigin(persisted.expression, hole.origin)]);
  };

  const expandCapturedHostReference = (
    name: string,
    origin: Origin,
  ): ts.Expression | undefined => {
    const hostValues = runtimeHostValues ??
      context.capturedHostValues.get(fragment.quote.id);

    if (!hostValues || !(name in hostValues)) {
      diagnostics.push({
        code: unresolvedResidualReference.code,
        message: `residual reference '${name}' resolved to a staging binding but was not captured`,
        origin,
      });
      return undefined;
    }

    const persisted = persistValueToExpression(hostValues[name]);

    if (!persisted.ok) {
      diagnostics.push({
        code: persistentValueUnsupported.code,
        message: `persistent reference '${name}' is unsupported: ${persisted.message}`,
        origin,
      });
      return undefined;
    }

    return setTreeOrigin(persisted.expression, origin);
  };

  const expandCapturedIdentifier = (
    hole: SpliceHole,
  ): ts.Identifier | undefined => {
    const captured = capturedValueForHole(
      fragment,
      hole,
      context.capturedValues,
      runtimeValues,
    );

    if (!captured.found) {
      return undefined;
    }

    if (typeof captured.value !== "string") {
      diagnostics.push({
        code: incompatibleSplice.code,
        message: `cannot splice persistent value '${hole.expression.getText()}' into ident position`,
        origin: hole.origin,
      });
      return undefined;
    }

    if (!isValidIdentifierText(captured.value)) {
      diagnostics.push({
        code: incompatibleSplice.code,
        message: `persistent splice '${hole.expression.getText()}' is not a valid identifier`,
        origin: hole.origin,
      });
      return undefined;
    }

    return setTreeOrigin(
      ts.factory.createIdentifier(captured.value),
      hole.origin,
    );
  };

  const expandCodeValues = (
    codeValues: CodeValue[],
    position: SyntaxPosition,
    hole: SpliceHole,
  ): ts.Node[] | undefined => {
    if (codeValues.length === 1) {
      return placement.placeCode(codeValues[0]!, position);
    }

    const replacements: ts.Node[] = [];

    for (const codeValue of codeValues) {
      const expanded = placement.placeCode(
        codeValue,
        {
          cardinality: "one",
          kind: position.kind,
          origin: position.origin,
        },
      );

      if (!expanded) {
        return undefined;
      }

      replacements.push(...expanded);
    }

    if (position.cardinality === "many") {
      return replacements;
    }

    if (replacements.length === 1) {
      return replacements;
    }

    diagnostics.push({
      code: incompatibleSplice.code,
      message: `cannot splice ${replacements.length} ${position.kind} nodes into ${position.kind} position`,
      origin: hole.origin,
    });
    return undefined;
  };

  const typedIdentifierBinding = (value: CodeValue): {
    name: ts.Identifier;
    type?: ts.TypeNode;
  } | undefined => {
    const expanded = context.expandValue(value);

    if (expanded.kind !== "ident") {
      return undefined;
    }

    const nodes = expanded.expandedNodes ?? expanded.parsed.nodes;
    const name = nodes[0];

    return name && ts.isIdentifier(name)
      ? {name, type: expanded.parsed.identType}
      : undefined;
  };

  const parameterReplacementsForSplice = (
    hole: SpliceHole,
    parameter: ts.ParameterDeclaration,
  ): ts.ParameterDeclaration[] | undefined => {
    const codeValues = spliceEvaluator.evaluateCodeSplice(hole);

    if (!codeValues) {
      return undefined;
    }

    const replacements: ts.ParameterDeclaration[] = [];

    for (const codeValue of codeValues) {
      const binding = typedIdentifierBinding(codeValue);

      if (!binding) {
        return undefined;
      }

      replacements.push(cloneParameterWithNameAndType(
        parameter,
        binding.name,
        parameter.type ?? binding.type,
      ));
    }

    return substitution.apply(replacements)
      .filter(ts.isParameter);
  };

  const variableDeclarationReplacementForSplice = (
    hole: SpliceHole,
    declaration: ts.VariableDeclaration,
  ): ts.VariableDeclaration | undefined => {
    const codeValues = spliceEvaluator.evaluateCodeSplice(hole);

    if (!codeValues || codeValues.length !== 1) {
      return undefined;
    }

    const binding = typedIdentifierBinding(codeValues[0]!);

    if (!binding) {
      return undefined;
    }

    const replacements = substitution.apply([
      copyNodeOrigin(
        ts.factory.updateVariableDeclaration(
          declaration,
          binding.name,
          declaration.exclamationToken,
          declaration.type ?? binding.type,
          declaration.initializer,
        ),
        declaration,
      ),
    ]);
    const replacement = replacements[0];

    return replacement && ts.isVariableDeclaration(replacement)
      ? replacement
      : undefined;
  };

  const expandCodeValue = (
    value: CodeValue,
    expected: FragmentKind,
    expectedCardinality: QuoteCardinality,
    origin: Origin,
  ): ts.Node[] | undefined => {
    if (context.isExpanding(value)) {
      context.expandValue(value);
      return undefined;
    }

    const expanded = context.expandValue(value);

    if (expanded.runtimeValues || expanded.runtimeHostValues) {
      values.set(expanded.quote.id, expanded);
    }

    addResidualImports(expanded.residualImports);

    const expandedNodes = expanded.expandedNodes ?? expanded.parsed.nodes;

    if (expanded.kind === "ident") {
      const replacements = identifierReplacementNodes(expandedNodes, expected);

      if (replacements) {
        return substitution.apply(replacements);
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
        return substitution.apply(replacements);
      }

      if (replacements.length === 1) {
        return substitution.apply(replacements);
      }

      diagnostics.push({
        code: incompatibleSplice.code,
        message: `cannot splice ${replacements.length} ${expanded.kind} nodes into ${expected} position`,
        origin,
      });
      return undefined;
    }

    if (expected === "expr" && expanded.kind === "block") {
      const adapted = adaptBlockToExpression(expandedNodes, origin);

      if (!adapted.ok) {
        diagnostics.push({
          code: blockExpressionAdapterFailed.code,
          message: adapted.message,
          origin,
        });
        return undefined;
      }

      return substitution.apply([adapted.expression]);
    }

    if (!isCompatible(expanded.kind, expected)) {
      diagnostics.push({
        code: incompatibleSplice.code,
        message: `cannot splice ${expanded.kind} code into ${expected} position`,
        origin,
      });
      return undefined;
    }

    return substitution.apply(expandedNodes);
  };

  const placement: Placement = {
    placeCode(value, position) {
      return expandCodeValue(
        value,
        position.kind,
        position.cardinality,
        position.origin,
      );
    },
    placeHostValue(name, position) {
      return expandCapturedHostReference(name, position.origin);
    },
    placeSplice: placeSpliceValue,
  };

  const expressionStatementReplacements = (
    statement: ts.ExpressionStatement,
  ): ts.Node[] | undefined => {
    if (!ts.isIdentifier(statement.expression)) {
      return undefined;
    }

    const hole = holes.get(statement.expression.text);

    if (hole) {
      return expandSpliceExpression(
        hole,
        "stmt",
        fragment.quote.cardinality,
      );
    }

    const resolved = environment.lookupValue(statement.expression);

    if (
      resolved.kind !== "code" ||
      !canImplicitlyPlaceAsStatement(resolved.value.kind)
    ) {
      return undefined;
    }

    return placement.placeCode(
      resolved.value,
      {
        cardinality: fragment.quote.cardinality,
        kind: "stmt",
        origin: originForNode(fragment, statement.expression),
      },
    );
  };

  const rewriteCandidate = (candidate: ts.Node): RewriteDecision => {
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

          return decisionFromTypeReplacement(expectedCardinality, replacements) ??
            {kind: "failed"};
        }

        const resolved = environment.lookupType(candidate);

        if (resolved.kind === "code") {
          const replacements = placement.placeCode(
            resolved.value,
            {
              cardinality: expectedCardinality,
              kind: "type",
              origin: originForNode(fragment, candidate),
            },
          );

          return decisionFromTypeReplacement(expectedCardinality, replacements) ??
            {kind: "keep"};
        }
      }
    }

    if (
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name)
    ) {
      const hole = holes.get(candidate.name.text);

      if (hole) {
        const replacement = variableDeclarationReplacementForSplice(hole, candidate);

        return replacement
          ? {kind: "replace", node: replacement, visitChildren: true}
          : {kind: "keep"};
      }
    }

    if (ts.isParameter(candidate) && ts.isIdentifier(candidate.name)) {
      const hole = holes.get(candidate.name.text);

      if (hole) {
        const typedReplacements = parameterReplacementsForSplice(hole, candidate);

        if (typedReplacements) {
          return {kind: "replaceMany", nodes: typedReplacements};
        }

        const replacements = expandSpliceExpression(hole, "pattern", "many");
        const bindingNames = bindingNameReplacements(replacements);

        return bindingNames
          ? {
              kind: "replaceMany",
              nodes: bindingNames.map((name) => cloneParameterWithName(candidate, name)),
            }
          : {kind: "failed"};
      }
    }

    if (
      ts.isExpressionStatement(candidate) &&
      ts.isIdentifier(candidate.expression)
    ) {
      const replacements = expressionStatementReplacements(candidate);

      return replacements
        ? {kind: "replaceMany", nodes: replacements}
        : {kind: "keep"};
    }

    if (ts.isIdentifier(candidate)) {
      const hole = holes.get(candidate.text);

      if (hole) {
        if (fragment.quote.kind === "ident") {
          const replacement = expandCapturedIdentifier(hole);

          return replacement
            ? {kind: "replace", node: replacement, visitChildren: false}
            : {kind: "keep"};
        }

        if (isExpressionListPosition(candidate)) {
          const replacements = expandSpliceExpression(hole, "expr", "many");

          return replacements && replacements.every(ts.isExpression)
            ? {kind: "replaceMany", nodes: replacements}
            : {kind: "keep"};
        }

        const replacement = expandSpliceExpression(hole, "expr")?.[0];

        return replacement && ts.isExpression(replacement)
          ? {
              kind: "replace",
              node: parenthesizeIfNeeded(replacement),
              visitChildren: false,
            }
          : {kind: "keep"};
      }

      const resolved = environment.lookupValue(candidate);

      if (resolved.kind === "code") {
        if (isExpressionListPosition(candidate)) {
          const replacements = placement.placeCode(
            resolved.value,
            {
              cardinality: "many",
              kind: "expr",
              origin: originForNode(fragment, candidate),
            },
          );

          return replacements && replacements.every(ts.isExpression)
            ? {kind: "replaceMany", nodes: replacements}
            : {kind: "keep"};
        }

        const replacement = placement.placeCode(
          resolved.value,
          {
            cardinality: "one",
            kind: "expr",
            origin: originForNode(fragment, candidate),
          },
        )?.[0];

        return replacement && ts.isExpression(replacement)
          ? {
              kind: "replace",
              node: parenthesizeIfNeeded(replacement),
              visitChildren: false,
            }
          : {kind: "keep"};
      }

      if (
        resolved.kind === "host-value" &&
        isReferenceIdentifier(candidate)
      ) {
        const replacement = placement.placeHostValue(
          resolved.name,
          {
            cardinality: isExpressionListPosition(candidate) ? "many" : "one",
            kind: "expr",
            origin: originForNode(fragment, candidate),
          },
        );

        if (replacement && isExpressionListPosition(candidate)) {
          return {kind: "replace", node: replacement, visitChildren: false};
        }

        return replacement
          ? {
              kind: "replace",
              node: parenthesizeIfNeeded(replacement),
              visitChildren: false,
            }
          : {kind: "keep"};
      }
    }

    return {kind: "keep"};
  };

  const expandedNodes = sourceNodes
    .flatMap((node) => {
      if (
        ts.isExpressionStatement(node) &&
        ts.isIdentifier(node.expression)
      ) {
        const replacements = expressionStatementReplacements(node);

        if (replacements) {
          return replacements;
        }
      }

      const transformed = transformNode(
        node,
        (candidate) => replacementFromRewriteDecision(
          rewriteCandidate(candidate),
          candidate,
        ),
      );

      return Array.isArray(transformed) ? transformed : [transformed];
    })
    .filter((node): node is ts.Node => Boolean(node));

  annotateFragmentNodeOrigins({...fragment, nodes: expandedNodes});

  return {
    diagnostics,
    nodes: expandedNodes,
    residualImports: Array.from(residualImports.values()),
  };
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

function canImplicitlyPlaceAsStatement(kind: FragmentKind): boolean {
  return kind === "stmt" || kind === "block" || kind === "decl";
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

function decisionFromTypeReplacement(
  expectedCardinality: QuoteCardinality,
  nodes: ts.Node[] | undefined,
): RewriteDecision | undefined {
  const replacements = typeReplacements(nodes);

  if (!replacements) {
    return undefined;
  }

  if (expectedCardinality === "many") {
    return {kind: "replaceMany", nodes: replacements};
  }

  const replacement = replacements[0];

  return replacement
    ? {kind: "replace", node: replacement, visitChildren: false}
    : undefined;
}

function bindingNameReplacements(
  nodes: ts.Node[] | undefined,
): ts.BindingName[] | undefined {
  return nodes?.every(isBindingName) ? nodes : undefined;
}

function cloneParameterWithName(
  parameter: ts.ParameterDeclaration,
  name: ts.BindingName,
): ts.ParameterDeclaration {
  return cloneParameterWithNameAndType(parameter, name, parameter.type);
}

function cloneParameterWithNameAndType(
  parameter: ts.ParameterDeclaration,
  name: ts.BindingName,
  type: ts.TypeNode | undefined,
): ts.ParameterDeclaration {
  return copyNodeOrigin(
    ts.factory.updateParameterDeclaration(
      parameter,
      ts.getModifiers(parameter),
      parameter.dotDotDotToken,
      name,
      parameter.questionToken,
      type,
      parameter.initializer,
    ),
    parameter,
  );
}

function originForNode(fragment: ParsedFragment, node: ts.Node): Origin {
  const explicitOrigin = getNodeOrigin(node);

  if (explicitOrigin) {
    return explicitOrigin;
  }

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

  const block = ts.factory.createBlock(statements, true);
  const arrow = ts.factory.createArrowFunction(
    undefined,
    undefined,
    [],
    undefined,
    ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    block,
  );
  const callee = ts.factory.createParenthesizedExpression(arrow);
  const call = ts.factory.createCallExpression(callee, undefined, []);

  setNodeOrigin(block, origin);
  setNodeOrigin(arrow, origin);
  setNodeOrigin(callee, origin);
  setNodeOrigin(call, origin);

  return {
    ok: true,
    expression: call,
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

function isValidIdentifierText(text: string): boolean {
  if (text.length === 0 || text.trim() !== text) {
    return false;
  }

  const sourceFile = ts.createSourceFile(
    "__typestage_identifier__.ts",
    `let ${text};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & {parseDiagnostics?: unknown[]})
      .parseDiagnostics ?? [];

  if (
    parseDiagnostics.length > 0 ||
    !statement ||
    !ts.isVariableStatement(statement)
  ) {
    return false;
  }

  const declaration = statement.declarationList.declarations[0];

  return Boolean(
    declaration &&
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === text,
  );
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

        return copyNodeOrigin(ts.visitEachChild(replaced, visit, context), replaced);
      };

      return (root) => ts.visitNode(root, visit) ?? root;
    },
  ]);
  const result = transformed.transformed[0] ?? node;

  transformed.dispose();

  return synthesizeNode(result);
}

function replacementFromRewriteDecision(
  decision: RewriteDecision,
  original: ts.Node,
): Replacement {
  switch (decision.kind) {
    case "keep":
      return original;

    case "replace":
      return decision.visitChildren
        ? decision.node
        : completedReplacement(decision.node);

    case "replaceMany":
      return decision.nodes;

    case "failed":
      return completedReplacement(original);
  }
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

    if (!getNodeOrigin(node)) {
      const childOrigin = originForChildren(node);

      if (childOrigin) {
        setNodeOrigin(node, childOrigin);
      }
    }
  };

  for (const node of fragment.nodes) {
    visit(node);
  }

  if (fragment.identType) {
    visit(fragment.identType);
  }
}

function originForChildren(node: ts.Node): Origin | undefined {
  let first: Origin | undefined;
  let incompatible = false;
  let previousStart = -1;

  ts.forEachChild(node, (child) => {
    if (incompatible) {
      return;
    }

    const origin = getNodeOrigin(child);

    if (!origin) {
      return;
    }

    if (
      (first && first.sourceFile !== origin.sourceFile) ||
      origin.start < previousStart
    ) {
      incompatible = true;
      return;
    }

    previousStart = origin.start;
    first = first
      ? {
          sourceFile: first.sourceFile,
          start: Math.min(first.start, origin.start),
          end: Math.max(first.end, origin.end),
        }
      : origin;
  });

  return first && !incompatible
    ? {
        sourceFile: first.sourceFile,
        start: first.start,
        end: first.end,
      }
    : undefined;
}
