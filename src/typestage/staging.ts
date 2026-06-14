/**
 * Dynamic staging evaluator for TypeStage source.
 * It rewrites TypeStage imports to the local runtime, wraps quote tags with
 * stable quote ids, mirrors graph modules into a temp tree, and imports the
 * entry module to capture actual interpolation values.
 */
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import * as ts from "typescript";
import {
  localModuleNotResolved,
  stagingEvaluationFailed,
} from "./diagnostics/index.ts";
import {
  __typestageCapturedValues,
  __typestageResetCapturedValues,
} from "./runtime.ts";
import type {Diagnostic, QuoteForm} from "./types.ts";

/** Values captured while evaluating a TypeStage source module. */
export type StagingEvaluation = {
  capturedValues: Map<number, unknown[]>;
  diagnostics: Diagnostic[];
};

/** Source module prepared for graph-wide staging evaluation. */
export type StagingGraphModule = {
  inputPath: string;
  relativePath: string;
  sourceFile: ts.SourceFile;
  quotes: QuoteForm[];
};

/** Resolves a local source import to its canonical source module path. */
export type StagingImportResolver = (
  specifier: string,
  importerPath: string,
) => string | undefined;

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

/** Evaluates an instrumented TypeStage module graph from its entry module. */
export async function evaluateStagingGraph(
  entryPath: string,
  modules: StagingGraphModule[],
  resolveImport: StagingImportResolver,
): Promise<StagingEvaluation> {
  const runtimeUrl = new URL("./runtime.ts", import.meta.url).href;
  const directory = await mkdtemp(join(tmpdir(), "typestage-"));
  const tempPaths = new Map<string, string>();

  for (const module of modules) {
    const tempPath = join(directory, module.relativePath);

    tempPaths.set(module.inputPath, tempPath);
    await mkdir(dirname(tempPath), {recursive: true});
  }

  for (const module of modules) {
    const tempPath = tempPaths.get(module.inputPath)!;
    const sourceText = stagingSource(
      module.sourceFile,
      module.quotes,
      runtimeUrl,
      (specifier) => {
        const targetPath = resolveImport(specifier, module.inputPath);
        const targetTempPath = targetPath ? tempPaths.get(targetPath) : undefined;

        return targetTempPath ? pathToFileURL(targetTempPath).href : undefined;
      },
    );

    await writeFile(tempPath, sourceText);
  }

  const entryTempPath = tempPaths.get(entryPath);

  if (!entryTempPath) {
    return {
      capturedValues: new Map(),
      diagnostics: [
        {
          code: localModuleNotResolved.code,
          message: `entry module '${entryPath}' was not found in the staging graph`,
        },
      ],
    };
  }

  __typestageResetCapturedValues();

  try {
    await import(`${pathToFileURL(entryTempPath).href}?t=${Date.now()}`);
  } catch (error) {
    return {
      capturedValues: __typestageCapturedValues(),
      diagnostics: [
        {
          code: stagingEvaluationFailed.code,
          message: `staging evaluation failed: ${errorMessage(error)}`,
        },
      ],
    };
  }

  return {
    capturedValues: __typestageCapturedValues(),
    diagnostics: [],
  };
}

function stagingSource(
  sourceFile: ts.SourceFile,
  quotes: QuoteForm[],
  runtimeUrl: string,
  resolveImport?: (specifier: string) => string | undefined,
): string {
  const quoteIds = new Map(
    quotes.map((quote) => [nodeKey(quote.node), quote.id]),
  );
  const helperName = freshHelperName(sourceFile);
  const baseDirectory = dirname(resolveSourcePath(sourceFile.fileName));
  const transformed = ts.transform(sourceFile, [
    (context) => {
      const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
        if (ts.isTaggedTemplateExpression(node)) {
          const quoteId = quoteIds.get(nodeKey(node));

          if (quoteId !== undefined) {
            const visited = ts.visitEachChild(node, visit, context);

            return ts.factory.updateTaggedTemplateExpression(
              visited,
              ts.factory.createCallExpression(
                ts.factory.createIdentifier(helperName),
                undefined,
                [ts.factory.createNumericLiteral(quoteId), visited.tag],
              ),
              visited.typeArguments,
              visited.template,
            );
          }
        }

        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const rewritten = rewriteModuleSpecifier(
            node.moduleSpecifier.text,
            runtimeUrl,
            baseDirectory,
            resolveImport,
          );

          if (rewritten !== node.moduleSpecifier.text) {
            const moduleSpecifier = ts.factory.createStringLiteral(rewritten);

            return ts.isImportDeclaration(node)
              ? ts.factory.updateImportDeclaration(
                  node,
                  ts.getModifiers(node),
                  node.importClause,
                  moduleSpecifier,
                  node.attributes,
                )
              : ts.factory.updateExportDeclaration(
                  node,
                  ts.getModifiers(node),
                  node.isTypeOnly,
                  node.exportClause,
                  moduleSpecifier,
                  node.attributes,
                );
          }
        }

        return ts.visitEachChild(node, visit, context);
      };

      return (node) => ts.visitEachChild(node, visit, context);
    },
  ]);
  const result = transformed.transformed[0] ?? sourceFile;
  const helperImport = ts.factory.createImportDeclaration(
    undefined,
    ts.factory.createImportClause(
      false,
      undefined,
      ts.factory.createNamedImports([
        ts.factory.createImportSpecifier(
          false,
          ts.factory.createIdentifier("__typestageTag"),
          ts.factory.createIdentifier(helperName),
        ),
      ]),
    ),
    ts.factory.createStringLiteral(runtimeUrl),
  );
  const stagingFile = ts.factory.updateSourceFile(result, [
    helperImport,
    ...result.statements,
  ]);
  const text = printer.printFile(stagingFile);

  transformed.dispose();

  return text;
}

function rewriteModuleSpecifier(
  specifier: string,
  runtimeUrl: string,
  baseDirectory: string,
  resolveImport?: (specifier: string) => string | undefined,
): string {
  if (specifier === "typestage") {
    return runtimeUrl;
  }

  if (!isRelativeSpecifier(specifier)) {
    return specifier;
  }

  return resolveImport?.(specifier) ??
    pathToFileURL(resolve(baseDirectory, specifier)).href;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function nodeKey(node: ts.Node): string {
  return `${node.pos}:${node.end}`;
}

function resolveSourcePath(fileName: string): string {
  return isAbsolute(fileName) ? fileName : resolve(process.cwd(), fileName);
}

function freshHelperName(sourceFile: ts.SourceFile): string {
  const used = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      used.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  let suffix = 0;
  let name = "__typestageTag";

  while (used.has(name)) {
    suffix++;
    name = `__typestageTag_${suffix}`;
  }

  return name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
