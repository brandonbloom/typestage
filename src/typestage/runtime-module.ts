/**
 * Runtime fragment module compiler.
 * This is the library-shaped entry point for callers that already have
 * RuntimeCode values and do not need a staging TypeScript file as a bridge.
 */
import * as ts from "typescript";
import {moduleStatementsForValue, printCodeValue} from "./emitter.ts";
import {expandFragments} from "./expander.ts";
import {parseFragments} from "./fragments.ts";
import {createRuntimeSemanticContext, type SemanticContext} from "./semantic.ts";
import {createSourceMappedOutput, type SourceMapBlock} from "./source-map.ts";
import {isRuntimeCode, type RuntimeCode} from "./runtime.ts";
import type {
  CodeValue,
  CompileGraphPipeline,
  CompileGraphResult,
  Origin,
  OriginMap,
  ParsedFragment,
  QuoteForm,
  SpliceHole,
  TemplatePart,
} from "./types.ts";

export type CompileRuntimeModuleOptions = {
  outputPath?: string;
  sourceFile?: string;
  sourceText?: string;
  sources?: Record<string, string>;
  sourceMaps?: boolean;
};

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

/** Compiles an already-created runtime code fragment as one residual module. */
export async function compileRuntimeModule(
  code: RuntimeCode | RuntimeCode[],
  options: CompileRuntimeModuleOptions = {},
): Promise<CompileGraphResult> {
  const root = Array.isArray(code)
    ? runtimeDeclsFromArray(code)
    : code;
  const outputPath = options.outputPath ?? "main.ts";
  const sourceFileName = options.sourceFile ?? "<runtime>";
  const runtimeGraph = runtimeQuoteGraph(root, outputPath, sourceFileName);
  const semantic = createRuntimeSemanticContext(
    `${outputPath}.runtime.ts`,
    "q.expr``;",
  );
  const parsed = parseFragments(runtimeGraph.quotes);
  const parseDiagnostics = parsed.diagnostics;
  const expanded = parseDiagnostics.length === 0
    ? expandRuntimeFragments(
        parsed.fragments,
        runtimeGraph.capturedValues,
        semantic,
      )
    : {
        diagnostics: [],
        values: runtimeGraph.localValues(parsed.fragments),
      };
  const diagnostics = [
    ...parseDiagnostics,
    ...expanded.diagnostics,
  ];
  const files = diagnostics.length === 0
    ? [runtimeModuleFile(
        outputPath,
        sourceFileName,
        root,
        expanded.values,
        runtimeGraph.sourceText,
        options,
        Boolean(options.sourceMaps),
      )]
    : [];

  return {
    diagnostics,
    files,
    pipeline: runtimePipelineSnapshot(
      outputPath,
      sourceFileName,
      parsed.fragments,
      expanded.values,
      diagnostics,
      files.length > 0,
    ),
  };
}

function runtimeDeclsFromArray(codes: RuntimeCode[]): RuntimeCode {
  const strings = Array.from({length: codes.length + 1}, () => "\n");

  return {
    __typestageRuntimeCode: true,
    cardinality: "many",
    kind: "decl",
    strings,
    text: strings.join(""),
    values: codes,
  };
}

function runtimeQuoteGraph(
  root: RuntimeCode,
  outputPath: string,
  sourceFileName: string,
): {
  capturedValues: Map<number, unknown[]>;
  localValues: (fragments: ParsedFragment[]) => Map<number, CodeValue>;
  quotes: QuoteForm[];
  sourceText: string;
} {
  const ids = new WeakMap<RuntimeCode, number>();
  let nextId = 0;
  const quotes: QuoteForm[] = [];
  const capturedValues = new Map<number, unknown[]>();
  const sourceTexts = new Map<number, string>();

  const visit = (value: unknown): void => {
    if (isRuntimeCode(value)) {
      if (ids.has(value)) {
        return;
      }

      const id = nextId++;
      ids.set(value, id);
      value.quoteId = id;

      for (const nested of value.values) {
        visit(nested);

        if (Array.isArray(nested)) {
          for (const item of nested) {
            visit(item);
          }
        }
      }

      const source = runtimeQuoteSource(value, id);

      sourceTexts.set(id, source);
      capturedValues.set(id, value.values);
      quotes.push(runtimeQuoteForm(value, id, outputPath, sourceFileName, source));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
    }
  };

  visit(root);

  return {
    capturedValues,
    localValues: (fragments) =>
      new Map(fragments.map((fragment) => [
        fragment.quote.id,
        {
          cardinality: fragment.quote.cardinality,
          kind: fragment.quote.kind,
          parsed: fragment,
          quote: fragment.quote,
        },
      ])),
    quotes,
    sourceText: Array.from(sourceTexts.entries())
      .sort(([left], [right]) => left - right)
      .map(([, source]) => source)
      .join("\n"),
  };
}

function runtimeQuoteSource(code: RuntimeCode, quoteId: number): string {
  return code.strings.reduce((source, part, index) => {
    const hole = index < code.values.length
      ? `__typestage_hole_${quoteId}_${index}`
      : "";

    return `${source}${part}${hole}`;
  }, "");
}

function runtimeQuoteForm(
  code: RuntimeCode,
  quoteId: number,
  outputPath: string,
  sourceFileName: string,
  source: string,
): QuoteForm {
  let offset = 0;
  const parts: TemplatePart[] = [];
  const holes: SpliceHole[] = [];

  for (const [index, text] of code.strings.entries()) {
    const defaultStart = offset;
    parts.push({
      text,
      originMap: partOriginMap(
        code.partOriginMaps?.[index],
        text,
        sourceFileName,
        defaultStart,
      ),
    });
    offset += text.length;

    if (index < code.values.length) {
      const placeholder = `__typestage_hole_${quoteId}_${index}`;
      const origin = {
        sourceFile: sourceFileName,
        start: offset,
        end: offset + placeholder.length,
      };
      const holeOrigin = code.holeOrigins?.[index] ?? origin;

      holes.push({
        index,
        placeholder,
        expression: expressionForText(placeholder),
        origin: holeOrigin,
      });
      offset += placeholder.length;
    }
  }

  return {
    cardinality: code.cardinality,
    exported: true,
    holes,
    id: quoteId,
    kind: code.kind,
    moduleId: outputPath,
    node: taggedTemplateForKind(code.kind),
    origin: codeOrigin(code) ?? {
      sourceFile: sourceFileName,
      start: 0,
      end: source.length,
    },
    parts,
    template: ts.factory.createNoSubstitutionTemplateLiteral(""),
  };
}

function partOriginMap(
  originMap: OriginMap | undefined,
  text: string,
  sourceFileName: string,
  start: number,
): OriginMap {
  if (originMap && originMap.length === text.length) {
    return originMap;
  }

  return Array.from({length: text.length}, (_, charIndex) => ({
    sourceFile: sourceFileName,
    start: start + charIndex,
    end: start + charIndex + 1,
  }));
}

function codeOrigin(code: RuntimeCode): Origin | undefined {
  for (const originMap of code.partOriginMaps ?? []) {
    const origin = originMap.find((candidate) => candidate !== undefined);

    if (origin) {
      return origin;
    }
  }

  return code.holeOrigins?.find((origin) => origin !== undefined);
}

function expressionForText(text: string): ts.Expression {
  const sourceFile = ts.createSourceFile(
    "runtime-hole.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];

  if (statement && ts.isExpressionStatement(statement)) {
    return statement.expression;
  }

  return ts.factory.createIdentifier(text);
}

function taggedTemplateForKind(kind: RuntimeCode["kind"]): ts.TaggedTemplateExpression {
  const sourceFile = ts.createSourceFile(
    "runtime-quote.ts",
    `q.${kind}\`\`;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];

  if (
    statement &&
    ts.isExpressionStatement(statement) &&
    ts.isTaggedTemplateExpression(statement.expression)
  ) {
    return statement.expression;
  }

  throw new Error(`could not construct runtime quote node for ${kind}`);
}

function expandRuntimeFragments(
  fragments: ParsedFragment[],
  capturedValues: Map<number, unknown[]>,
  semantic: SemanticContext,
) {
  return expandFragments(
    fragments,
    new Map(),
    capturedValues,
    new Map(),
    semantic,
  );
}

function runtimeModuleFile(
  outputPath: string,
  sourceFileName: string,
  root: RuntimeCode,
  values: Map<number, CodeValue>,
  sourceText: string,
  options: CompileRuntimeModuleOptions,
  sourceMaps: boolean,
) {
  const rootValue = root.quoteId === undefined ? undefined : values.get(root.quoteId);
  const statements = rootValue ? moduleStatementsForValue(rootValue) : [];
  const text = printStatements(statements);
  const sourceMapPath = `${outputPath}.map`;
  const blocks: SourceMapBlock[] = [
    {
      statements,
      text,
    },
  ];
  const sourceMapped = createSourceMappedOutput(
    outputPath,
    blocks,
    (sourceFile) => {
      if (sourceFile === sourceFileName) {
        return options.sourceText ?? sourceText;
      }

      return options.sources?.[sourceFile] ?? "";
    },
  );

  return {
    inputPath: sourceFileName,
    outputPath,
    sourceMapPath: sourceMaps ? sourceMapPath : undefined,
    sourceMapText: sourceMaps ? sourceMapped.sourceMapText : undefined,
    outputText: sourceMaps ? sourceMapped.outputText : text,
  };
}

function runtimePipelineSnapshot(
  outputPath: string,
  sourceFileName: string,
  fragments: ParsedFragment[],
  values: Map<number, CodeValue>,
  diagnostics: CompileGraphResult["diagnostics"],
  emitted: boolean,
): CompileGraphPipeline {
  return {
    modules: [
      {
        inputPath: sourceFileName,
        outputPath,
        quotes: fragments.map((fragment) => ({
          id: fragment.quote.id,
          kind: fragment.quote.kind,
          moduleId: fragment.quote.moduleId,
          bindingName: fragment.quote.bindingName,
          exported: fragment.quote.exported,
        })),
        bindings: {
          codeBindings: [],
          localBindingsByQuote: fragments.map((fragment) => ({
            quoteId: fragment.quote.id,
            names: [],
          })),
        },
      },
    ],
    expanded: Array.from(values.values()).map((value) => ({
      quoteId: value.quote.id,
      moduleId: value.quote.moduleId,
      kind: value.kind,
      text: printCodeValue(value),
    })),
    diagnostics,
    files: emitted ? [{inputPath: sourceFileName, outputPath}] : [],
  };
}

function printStatements(statements: ts.Statement[]): string {
  if (statements.length === 0) {
    return "";
  }

  const sourceFile = ts.factory.createSourceFile(
    statements,
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );

  return `${printer.printFile(sourceFile).trimEnd()}\n`;
}
