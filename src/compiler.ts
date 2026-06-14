import {writeFileSync} from "node:fs";
import * as ts from "typescript";
import {printExpressionList, printNode, printNodes} from "./ast-print.ts";
import {
  buildCodeBindings,
  summarizeBindings,
  type BindingSummary,
} from "./binder.ts";
import {expandFragments} from "./expander.ts";
import {parseFragments} from "./fragments.ts";
import {extractQuotes, parseHostSource} from "./quote-extractor.ts";
import {evaluateStagingModule} from "./staging.ts";
import type {CodeValue, CompileResult, Diagnostic} from "./types.ts";

/** Serializable view of each compiler phase used by fixture diagnostics. */
export type PipelineSnapshot = {
  quotes: Array<{
    id: number;
    kind: string;
    bindingName?: string;
    exported: boolean;
    source: string;
    holes: Array<{
      placeholder: string;
      expression: string;
    }>;
  }>;
  fragments: Array<{
    quoteId: number;
    virtualSource: string;
    nodes: string[];
  }>;
  bindings: BindingSummary;
  expanded: Array<{
    quoteId: number;
    kind: string;
    text: string;
  }>;
  diagnostics: Diagnostic[];
  outputText: string;
};

/** Compiles TypeStage source text into residual TypeScript and diagnostics. */
export async function compileSource(
  sourceText: string,
  fileName = "input.ts",
): Promise<CompileResult> {
  const pipeline = await runPipeline(sourceText, fileName);

  return {
    diagnostics: pipeline.diagnostics,
    outputText: pipeline.outputText,
    quotes: pipeline.quotesRaw,
  };
}

/** Runs the compiler and returns a stable phase-by-phase debug snapshot. */
export async function snapshotPipeline(
  sourceText: string,
  fileName = "input.ts",
): Promise<PipelineSnapshot> {
  const pipeline = await runPipeline(sourceText, fileName);

  return {
    quotes: pipeline.quotesRaw.map((quote) => ({
      id: quote.id,
      kind: quote.kind,
      bindingName: quote.bindingName,
      exported: quote.exported,
      source: pipeline.fragmentsByQuote.get(quote.id)?.source ?? "",
      holes: quote.holes.map((hole) => ({
        placeholder: hole.placeholder,
        expression: hole.expression.getText(pipeline.hostSourceFile),
      })),
    })),
    fragments: pipeline.fragments.map((fragment) => ({
      quoteId: fragment.quote.id,
      virtualSource: fragment.virtualSource,
      nodes: fragment.nodes.map((node) => node.getText(fragment.sourceFile)),
    })),
    bindings: pipeline.bindings,
    expanded: Array.from(pipeline.expanded.values()).map((value) => ({
      quoteId: value.quote.id,
      kind: value.kind,
      text: printCodeValue(value),
    })),
    diagnostics: pipeline.diagnostics,
    outputText: pipeline.outputText,
  };
}

/** Compiles a TypeStage file and optionally writes the residual output file. */
export function emitFile(inputPath: string, outputPath: string | undefined) {
  const sourceText = Bun.file(inputPath).text();

  return sourceText.then(async (text) => {
    const result = await compileSource(text, inputPath);

    if (outputPath) {
      writeFileSync(outputPath, result.outputText);
    }

    return result;
  });
}

async function runPipeline(sourceText: string, fileName: string) {
  const hostSourceFile = parseHostSource(sourceText, fileName);
  const quotesRaw = extractQuotes(hostSourceFile);
  const parsed = parseFragments(quotesRaw);
  const codeBindings = buildCodeBindings(parsed.fragments);
  const staging = await evaluateStagingModule(hostSourceFile, quotesRaw);
  const bindings = summarizeBindings(parsed.fragments, codeBindings);
  const expanded = expandFragments(
    parsed.fragments,
    codeBindings,
    staging.capturedValues,
  );
  const diagnostics = [
    ...parsed.diagnostics,
    ...staging.diagnostics,
    ...expanded.diagnostics,
  ];
  const outputText = diagnostics.length === 0 ? emitModule(expanded.values) : "";

  return {
    bindings,
    diagnostics,
    expanded: expanded.values,
    fragments: parsed.fragments,
    fragmentsByQuote: new Map(
      parsed.fragments.map((fragment) => [fragment.quote.id, fragment]),
    ),
    hostSourceFile,
    outputText,
    quotesRaw,
  };
}

function emitModule(values: Map<number, CodeValue>): string {
  const statements: ts.Statement[] = [];

  for (const value of values.values()) {
    if (!value.quote.exported) {
      continue;
    }

    statements.push(...moduleStatementsForValue(value));
  }

  return printNodes(statements);
}

function moduleStatementsForValue(value: CodeValue): ts.Statement[] {
  const nodes = value.expandedNodes ?? value.parsed.nodes;

  if (value.kind === "decl") {
    return nodes.filter(ts.isStatement);
  }

  if (value.kind === "expr" && value.cardinality === "one" && value.quote.bindingName) {
    const expression = nodes[0];

    if (!expression || !ts.isExpression(expression)) {
      return [];
    }

    return [
      ts.factory.createVariableStatement(
        [ts.factory.createModifier(ts.SyntaxKind.ExportKeyword)],
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              value.quote.bindingName,
              undefined,
              undefined,
              expression,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      ),
    ];
  }

  return nodes.filter(ts.isStatement);
}

function printCodeValue(value: CodeValue): string {
  const nodes = value.expandedNodes ?? value.parsed.nodes;
  const syntaxNodes = syntaxSequenceNodes(value.kind, value.cardinality, nodes);

  if (syntaxNodes) {
    return syntaxSequenceText(value.kind, syntaxNodes);
  }

  return printNodes(nodes.filter(ts.isStatement));
}

function syntaxSequenceNodes(
  kind: CodeValue["kind"],
  cardinality: CodeValue["cardinality"],
  nodes: ts.Node[],
): ts.Node[] | undefined {
  const syntaxNodes: ts.Node[] = [];

  for (const node of nodes) {
    switch (kind) {
      case "expr":
        if (!ts.isExpression(node)) {
          return undefined;
        }

        syntaxNodes.push(cardinality === "one" ? unwrapExpressionListElement(node) : node);
        break;

      case "ident":
        if (!ts.isIdentifier(node)) {
          return undefined;
        }

        syntaxNodes.push(node);
        break;

      case "type":
        if (!ts.isTypeNode(node)) {
          return undefined;
        }

        syntaxNodes.push(node);
        break;

      case "pattern":
        if (!isBindingName(node)) {
          return undefined;
        }

        syntaxNodes.push(node);
        break;

      case "stmt":
      case "block":
      case "decl":
        return undefined;
    }
  }

  return syntaxNodes;
}

function syntaxSequenceText(kind: CodeValue["kind"], nodes: ts.Node[]): string {
  return kind === "expr" && nodes.every(ts.isExpression)
    ? printExpressionList(nodes)
    : nodes.map(printNode).join(", ");
}

function unwrapExpressionListElement(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression)
    ? expression.expression
    : expression;
}

function isBindingName(node: ts.Node): node is ts.BindingName {
  return (
    ts.isIdentifier(node) ||
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node)
  );
}
