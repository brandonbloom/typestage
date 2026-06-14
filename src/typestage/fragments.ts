/**
 * Parser bridge from raw quote forms to TypeScript AST fragments.
 * Each quote body is wrapped with a grammar-specific scaffold so the
 * TypeScript parser can parse expressions, types, patterns, statements, and
 * declarations through ordinary syntax entry points.
 */
import * as ts from "typescript";
import {quoteSource} from "./quote-extractor.ts";
import type {
  Diagnostic,
  FragmentKind,
  ParsedFragment,
  QuoteCardinality,
  QuoteForm,
} from "./types.ts";

type WrappedFragment = {
  source: string;
  prefix: string;
};

/** Parses all quote forms into virtual TypeScript fragments. */
export function parseFragments(quotes: QuoteForm[]): {
  diagnostics: Diagnostic[];
  fragments: ParsedFragment[];
} {
  const diagnostics: Diagnostic[] = [];
  const fragments: ParsedFragment[] = [];

  for (const quote of quotes) {
    const parsed = parseFragment(quote);

    diagnostics.push(...parsed.diagnostics);
    fragments.push(parsed.fragment);
  }

  return {diagnostics, fragments};
}

/** Parses one quote form into its fragment AST and parse diagnostics. */
export function parseFragment(quote: QuoteForm): {
  diagnostics: Diagnostic[];
  fragment: ParsedFragment;
} {
  const source = quoteSource(quote);
  const wrapped = wrapFragment(quote.kind, quote.cardinality, source.source);
  const virtualFileName = `${quote.origin.sourceFile}.${quote.id}.${quote.kind}.virtual.ts`;
  const sourceFile = ts.createSourceFile(
    virtualFileName,
    wrapped.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fragmentStart = wrapped.prefix.length;
  const parseDiagnostics = getParseDiagnostics(sourceFile);
  const diagnostics = parseDiagnostics.map((diagnostic) =>
    remapParseDiagnostic(quote, source.originMap, fragmentStart, diagnostic),
  );

  return {
    diagnostics,
    fragment: {
      quote,
      source: source.source,
      originMap: source.originMap,
      virtualSource: wrapped.source,
      virtualFileName,
      fragmentStart,
      sourceFile,
      nodes: fragmentNodes(quote.kind, quote.cardinality, sourceFile),
    },
  };
}

function getParseDiagnostics(sourceFile: ts.SourceFile): ts.DiagnosticWithLocation[] {
  const candidate = sourceFile as ts.SourceFile & {
    parseDiagnostics?: ts.DiagnosticWithLocation[];
  };

  return candidate.parseDiagnostics ?? [];
}

function wrapFragment(
  kind: FragmentKind,
  cardinality: QuoteCardinality,
  source: string,
): WrappedFragment {
  switch (kind) {
    case "expr": {
      if (cardinality === "many") {
        const prefix = "const __typestage_fragment = [";
        const suffix = "];\n";

        return {source: `${prefix}${source}${suffix}`, prefix};
      }

      const prefix = "const __typestage_fragment = (";
      const suffix = ");\n";

      return {source: `${prefix}${source}${suffix}`, prefix};
    }

    case "ident": {
      const prefix = "const __typestage_fragment = ";
      const suffix = ";\n";

      return {source: `${prefix}${source}${suffix}`, prefix};
    }

    case "type": {
      if (cardinality === "many") {
        const prefix = "type __typestage_fragment = [";
        const suffix = "];\n";

        return {source: `${prefix}${source}${suffix}`, prefix};
      }

      const prefix = "type __typestage_fragment = ";
      const suffix = ";\n";

      return {source: `${prefix}${source}${suffix}`, prefix};
    }

    case "pattern": {
      const prefix = "function __typestage_fragment(";
      const suffix = ") {}\n";

      return {source: `${prefix}${source}${suffix}`, prefix};
    }

    case "stmt": {
      const prefix = "function __typestage_fragment() {\n";
      const suffix = "\n}\n";

      return {source: `${prefix}${source}${suffix}`, prefix};
    }

    case "block": {
      const prefix = "function __typestage_fragment() {\n";
      const suffix = "\n}\n";

      return {source: `${prefix}${source}${suffix}`, prefix};
    }

    case "decl":
      return {source: `${source}\n`, prefix: ""};
  }
}

function fragmentNodes(
  kind: FragmentKind,
  cardinality: QuoteCardinality,
  sourceFile: ts.SourceFile,
): ts.Node[] {
  switch (kind) {
    case "expr": {
      const statement = sourceFile.statements[0];

      if (!statement || !ts.isVariableStatement(statement)) {
        return [];
      }

      const declaration = statement.declarationList.declarations[0];
      const initializer = declaration?.initializer;

      if (!initializer) {
        return [];
      }

      return cardinality === "many" && ts.isArrayLiteralExpression(initializer)
        ? Array.from(initializer.elements)
        : [initializer];
    }

    case "ident": {
      const statement = sourceFile.statements[0];

      if (!statement || !ts.isVariableStatement(statement)) {
        return [];
      }

      const declaration = statement.declarationList.declarations[0];
      const initializer = declaration?.initializer;

      return initializer && ts.isIdentifier(initializer) ? [initializer] : [];
    }

    case "type": {
      const statement = sourceFile.statements[0];

      if (!statement || !ts.isTypeAliasDeclaration(statement)) {
        return [];
      }

      return cardinality === "many" && ts.isTupleTypeNode(statement.type)
        ? Array.from(statement.type.elements)
        : [statement.type];
    }

    case "pattern": {
      const statement = sourceFile.statements[0];

      if (!statement || !ts.isFunctionDeclaration(statement)) {
        return [];
      }

      return statement.parameters.map((parameter) => parameter.name);
    }

    case "stmt":
    case "block": {
      const statement = sourceFile.statements[0];

      if (!statement || !ts.isFunctionDeclaration(statement) || !statement.body) {
        return [];
      }

      return Array.from(statement.body.statements);
    }

    case "decl":
      return Array.from(sourceFile.statements);
  }
}

function remapParseDiagnostic(
  quote: QuoteForm,
  originMap: ParsedFragment["originMap"],
  fragmentStart: number,
  diagnostic: ts.DiagnosticWithLocation,
): Diagnostic {
  const fragmentOffset = Math.max(0, diagnostic.start - fragmentStart);
  const origin =
    originMap[Math.min(fragmentOffset, Math.max(0, originMap.length - 1))] ??
    quote.origin;

  return {
    code: `TS${diagnostic.code}`,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    origin,
  };
}
