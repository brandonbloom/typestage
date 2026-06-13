import * as ts from "typescript";
import {quoteSource} from "./quote-extractor.ts";
import type {Diagnostic, FragmentKind, ParsedFragment, QuoteForm} from "./types.ts";

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
  const wrapped = wrapFragment(quote.kind, source.source);
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
      nodes: fragmentNodes(quote.kind, sourceFile),
    },
  };
}

function getParseDiagnostics(sourceFile: ts.SourceFile): ts.DiagnosticWithLocation[] {
  const candidate = sourceFile as ts.SourceFile & {
    parseDiagnostics?: ts.DiagnosticWithLocation[];
  };

  return candidate.parseDiagnostics ?? [];
}

function wrapFragment(kind: FragmentKind, source: string): WrappedFragment {
  switch (kind) {
    case "expr": {
      const prefix = "const __typestage_fragment = (";
      const suffix = ");\n";

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

function fragmentNodes(kind: FragmentKind, sourceFile: ts.SourceFile): ts.Node[] {
  switch (kind) {
    case "expr": {
      const statement = sourceFile.statements[0];

      if (!statement || !ts.isVariableStatement(statement)) {
        return [];
      }

      const declaration = statement.declarationList.declarations[0];

      return declaration?.initializer ? [declaration.initializer] : [];
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
