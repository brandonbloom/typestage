import * as ts from "typescript";
import {
  dirname as dirnamePath,
  isAbsolute as isAbsolutePath,
  join as joinPath,
  normalize as normalizePath,
} from "pathe";
import type {Diagnostic, QuoteForm} from "./types.ts";

/** Values captured while evaluating a TypeStage source module. */
export type StagingEvaluation = {
  capturedValues: Map<number, unknown[]>;
  capturedHostValues: Map<number, Record<string, unknown>>;
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

/** Evaluates an instrumented TypeStage module graph. */
export type StagingEvaluator = (
  entryPath: string,
  modules: StagingGraphModule[],
  resolveImport: StagingImportResolver,
  hostCaptureNames?: Map<number, Set<string>>,
) => Promise<StagingEvaluation>;

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

export function stagingSource(
  sourceFile: ts.SourceFile,
  quotes: QuoteForm[],
  runtimeUrl: string,
  hostCaptureNames: Map<number, Set<string>>,
  resolveImport?: (specifier: string) => string | undefined,
): string {
  const quoteIds = new Map(
    quotes.map((quote) => [nodeKey(quote.node), quote.id]),
  );
  const helperName = freshHelperName(sourceFile);
  const baseDirectory = dirnamePath(resolveSourcePath(sourceFile.fileName));
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
                [
                  ts.factory.createNumericLiteral(quoteId),
                  visited.tag,
                  ...hostCaptureArgument(hostCaptureNames.get(quoteId)),
                ],
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

function hostCaptureArgument(names: Set<string> | undefined): ts.Expression[] {
  if (!names || names.size === 0) {
    return [];
  }

  return [
    ts.factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      ts.factory.createParenthesizedExpression(
        ts.factory.createObjectLiteralExpression(
          Array.from(names)
            .sort()
            .map((name) =>
              ts.factory.createShorthandPropertyAssignment(
                ts.factory.createIdentifier(name),
              )
            ),
          false,
        ),
      ),
    ),
  ];
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

  return resolveImport?.(specifier) ?? resolvePath(baseDirectory, specifier);
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function nodeKey(node: ts.Node): string {
  return `${node.pos}:${node.end}`;
}

function resolveSourcePath(fileName: string): string {
  return isAbsolutePath(fileName) ? fileName : resolvePath("/", fileName);
}

function resolvePath(currentDirectory: string, ...parts: string[]): string {
  let resolved = normalizePath(currentDirectory);

  for (const part of parts) {
    if (!part) {
      continue;
    }

    resolved = isAbsolutePath(part) ? normalizePath(part) : joinPath(resolved, part);
  }

  return resolved;
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
