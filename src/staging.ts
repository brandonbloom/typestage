import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import * as ts from "typescript";
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

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

/** Evaluates a source module with instrumented TypeStage quote tags. */
export async function evaluateStagingModule(
  sourceFile: ts.SourceFile,
  quotes: QuoteForm[],
): Promise<StagingEvaluation> {
  const runtimeUrl = new URL("./runtime.ts", import.meta.url).href;
  const sourceText = stagingSource(sourceFile, quotes, runtimeUrl);
  const directory = await mkdtemp(join(tmpdir(), "typestage-"));
  const modulePath = join(directory, "staging.ts");

  await writeFile(modulePath, sourceText);
  __typestageResetCapturedValues();

  try {
    await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
  } catch (error) {
    return {
      capturedValues: __typestageCapturedValues(),
      diagnostics: [
        {
          code: "TSG1006",
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
            return ts.factory.updateTaggedTemplateExpression(
              node,
              ts.factory.createCallExpression(
                ts.factory.createIdentifier(helperName),
                undefined,
                [ts.factory.createNumericLiteral(quoteId), node.tag],
              ),
              node.typeArguments,
              node.template,
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
): string {
  if (specifier === "typestage") {
    return runtimeUrl;
  }

  return isRelativeSpecifier(specifier)
    ? pathToFileURL(resolve(baseDirectory, specifier)).href
    : specifier;
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
