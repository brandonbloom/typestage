import * as ts from "typescript";
import {unresolvedResidualReference} from "./diagnostics/index.ts";
import {
  collectBindingName,
  collectBindingsInNode,
  walkScopedReferences,
} from "./residual-scope.ts";
import {
  resolveHostTypeName,
  resolveHostValueName,
  type SemanticContext,
} from "./semantic.ts";
import {codeValueForExpression} from "./splice-evaluator.ts";
import type {CodeValue, Diagnostic, Origin, ParsedFragment, ResidualImport} from "./types.ts";

export type ValueBinding =
  | {kind: "residual-local"}
  | {kind: "code"; value: CodeValue}
  | {kind: "import"; value: ResidualImport}
  | {kind: "host-value"; name: string}
  | {kind: "ambient"}
  | {kind: "unresolved"};

export type TypeBinding = Exclude<ValueBinding, {kind: "host-value"}>;

type ReferenceResolution = Exclude<ValueBinding, {kind: "residual-local"}>;

type ReferenceAnalysis = {
  diagnostics: Diagnostic[];
  hostNames: Set<string>;
  residualImports: Map<string, ResidualImport>;
  identifiers: WeakMap<ts.Identifier, ReferenceResolution>;
  typeReferences: WeakMap<ts.TypeReferenceNode, ReferenceResolution>;
};

export class Environment {
  private readonly analysis: ReferenceAnalysis;

  private constructor(analysis: ReferenceAnalysis) {
    this.analysis = analysis;
  }

  static analyze(
    fragment: ParsedFragment,
    codeBindings: Map<string, CodeValue>,
    semantic?: SemanticContext,
    importBindings: Map<string, ResidualImport> = new Map(),
    options: {
      diagnoseUnresolved?: boolean;
      onlyCurrentOrigin?: boolean;
      originForNode?: (node: ts.Node) => Origin;
    } = {},
  ): Environment {
    return new Environment(analyzeResidualReferences(
      fragment,
      codeBindings,
      semantic,
      importBindings,
      options,
    ));
  }

  get diagnostics(): Diagnostic[] {
    return this.analysis.diagnostics;
  }

  get residualImports(): Map<string, ResidualImport> {
    return this.analysis.residualImports;
  }

  collectHostCaptures(): Set<string> {
    return this.analysis.hostNames;
  }

  lookupValue(identifier: ts.Identifier): ValueBinding {
    return this.analysis.identifiers.get(identifier) ?? {kind: "residual-local"};
  }

  lookupType(node: ts.TypeReferenceNode): TypeBinding {
    const binding = this.analysis.typeReferences.get(node);

    return binding && binding.kind !== "host-value"
      ? binding
      : {kind: "ambient"};
  }
}

function analyzeResidualReferences(
  fragment: ParsedFragment,
  codeBindings: Map<string, CodeValue>,
  semantic?: SemanticContext,
  importBindings: Map<string, ResidualImport> = new Map(),
  options: {
    diagnoseUnresolved?: boolean;
    onlyCurrentOrigin?: boolean;
    originForNode?: (node: ts.Node) => Origin;
  } = {},
): ReferenceAnalysis {
  const diagnostics: Diagnostic[] = [];
  const hostNames = new Set<string>();
  const residualImports = new Map<string, ResidualImport>();
  const identifiers = new WeakMap<ts.Identifier, ReferenceResolution>();
  const typeReferences = new WeakMap<ts.TypeReferenceNode, ReferenceResolution>();
  const holeNames = new Set(fragment.quote.holes.map((hole) => hole.placeholder));
  const codeValuesByHoleName = new Map(
    fragment.quote.holes.flatMap((hole): Array<[string, CodeValue]> => {
      const value = codeValueForExpression(hole.expression, codeBindings, new Map());

      return value ? [[hole.placeholder, value]] : [];
    }),
  );

  const resolveValueReference = (identifier: ts.Identifier): ReferenceResolution => {
    const binding = codeBindings.get(identifier.text);

    if (
      binding &&
      binding.quote.id !== fragment.quote.id &&
      codeBindingMatchesPosition(binding.kind, "expr")
    ) {
      return {kind: "code", value: binding};
    }

    const imported = importBindings.get(identifier.text);

    if (imported && !imported.isTypeOnly) {
      residualImports.set(residualImportKey(imported), imported);
      return {kind: "import", value: imported};
    }

    if (resolveHostValueName(semantic, fragment, identifier.text, true)) {
      hostNames.add(identifier.text);
      return {kind: "host-value", name: identifier.text};
    }

    if (resolveHostValueName(semantic, fragment, identifier.text, false)) {
      return {kind: "ambient"};
    }

    diagnoseUnresolvedReference(
      identifier,
      `residual reference '${identifier.text}' does not resolve to a local binding, staging binding, or ambient global`,
    );
    return {kind: "unresolved"};
  };

  const resolveTypeReference = (node: ts.TypeReferenceNode): ReferenceResolution => {
    const name = typeReferenceIdentifier(node);

    if (!name) {
      return {kind: "ambient"};
    }

    const binding = codeBindings.get(name.text);

    if (
      binding &&
      binding.quote.id !== fragment.quote.id &&
      codeBindingMatchesPosition(binding.kind, "type")
    ) {
      return {kind: "code", value: binding};
    }

    const imported = importBindings.get(name.text);

    if (imported) {
      residualImports.set(residualImportKey(imported), imported);
      return {kind: "import", value: imported};
    }

    if (
      resolveHostTypeName(semantic, fragment, name.text, true) ||
      resolveHostTypeName(semantic, fragment, name.text, false)
    ) {
      return {kind: "ambient"};
    }

    diagnoseUnresolvedReference(
      name,
      `residual type reference '${name.text}' does not resolve to a local type, staging type, or ambient type`,
    );
    return {kind: "unresolved"};
  };

  const diagnoseUnresolvedReference = (node: ts.Node, message: string) => {
    if (!options.diagnoseUnresolved) {
      return;
    }

    const origin = options.originForNode?.(node) ?? fallbackOriginForNode(node);

    if (options.onlyCurrentOrigin && !originWithinQuote(origin, fragment)) {
      return;
    }

    diagnostics.push({
      code: unresolvedResidualReference.code,
      message,
      origin,
    });
  };

  walkScopedReferences(fragment.nodes, {
    collectBindingName(name, names) {
      collectBindingNameFromResidualPattern(
        name,
        names,
        holeNames,
        codeValuesByHoleName,
      );
    },
    onTypeReference(node, name) {
      if (name && !holeNames.has(name.text)) {
        typeReferences.set(node, resolveTypeReference(node));
      }
    },
    onValueReference(identifier) {
      if (!holeNames.has(identifier.text)) {
        identifiers.set(identifier, resolveValueReference(identifier));
      }
    },
  });

  return {diagnostics, hostNames, residualImports, identifiers, typeReferences};
}

export function residualImportKey(residualImport: ResidualImport): string {
  return [
    residualImport.moduleId,
    residualImport.specifier,
    residualImport.imported,
    residualImport.local,
    residualImport.isTypeOnly ? "type" : "value",
  ].join("\0");
}

function originWithinQuote(origin: Origin, fragment: ParsedFragment): boolean {
  return (
    origin.sourceFile === fragment.quote.origin.sourceFile &&
    origin.start >= fragment.quote.origin.start &&
    origin.end <= fragment.quote.origin.end
  );
}

function collectBindingNameFromResidualPattern(
  name: ts.BindingName,
  names: Set<string>,
  holeNames: Set<string>,
  codeValuesByHoleName: Map<string, CodeValue>,
) {
  if (ts.isIdentifier(name) && holeNames.has(name.text)) {
    const hole = name.text;
    const codeValue = codeValuesByHoleName.get(hole);

    if (codeValue) {
      for (const node of codeValue.expandedNodes ?? codeValue.parsed.nodes) {
        collectBindingsInNode(node, names);
      }
    }
    return;
  }

  collectBindingName(name, names);
}

function codeBindingMatchesPosition(kind: CodeValue["kind"], expected: "expr" | "type") {
  return (
    (expected === "expr" && (kind === "expr" || kind === "ident" || kind === "block")) ||
    (expected === "type" && (kind === "type" || kind === "ident"))
  );
}

function typeReferenceIdentifier(node: ts.TypeReferenceNode): ts.Identifier | undefined {
  return ts.isIdentifier(node.typeName) && !node.typeArguments
    ? node.typeName
    : undefined;
}

function fallbackOriginForNode(node: ts.Node): Origin {
  const sourceFile = node.getSourceFile();

  return {
    sourceFile: sourceFile.fileName,
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  };
}
