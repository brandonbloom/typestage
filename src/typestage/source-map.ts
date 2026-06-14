/**
 * Source map generation and lookup for residual TypeScript.
 * The graph emitter prints TypeScript ASTs into output blocks; this module
 * matches emitted tokens back to node origins and writes standard v3 mappings
 * that external tools can consume or TypeStage tests can remap diagnostics
 * through after running an external checker.
 */
import {basename} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import * as ts from "typescript";
import {getNodeOrigin, originForRange} from "./origin.ts";
import type {Origin} from "./types.ts";

/** A printed output block with the AST statements that produced it. */
export type SourceMapBlock = {
  origin?: Origin;
  sourceFile?: ts.SourceFile;
  statements: readonly ts.Statement[];
  text: string;
};

/** Residual output and its corresponding v3 source map. */
export type SourceMappedOutput = {
  outputText: string;
  sourceMapText: string;
};

type GeneratedToken = {
  column: number;
  kind: ts.SyntaxKind;
  line: number;
  text: string;
};

type OriginToken = {
  kind: ts.SyntaxKind;
  origin: Origin;
  text: string;
};

type Mapping = {
  generatedColumn: number;
  generatedLine: number;
  sourceColumn: number;
  sourceFile: string;
  sourceLine: number;
};

const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Values = new Map(Array.from(base64Digits, (digit, index) => [digit, index]));
const emptySourceFile = ts.createSourceFile(
  "typestage-generated.ts",
  "",
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

/** Combines printed blocks and creates a standard v3 source map. */
export function createSourceMappedOutput(
  outputPath: string,
  blocks: SourceMapBlock[],
  sourceTextForFile: (sourceFile: string) => string,
): SourceMappedOutput {
  const outputText = combineBlocks(blocks.map((block) => block.text));
  const mappings = blockMappings(blocks, sourceTextForFile);
  const sourceFiles = Array.from(new Set(mappings.map((mapping) => mapping.sourceFile)));

  return {
    outputText,
    sourceMapText: `${JSON.stringify({
      version: 3,
      file: basename(outputPath),
      sources: sourceFiles,
      sourcesContent: sourceFiles.map(sourceTextForFile),
      names: [],
      mappings: encodeMappings(mappings, sourceFiles),
    }, null, 2)}\n`,
  };
}

/** Maps a generated one-based line and column through a v3 source map. */
export function originalPositionForGeneratedLocation(
  sourceMapText: string,
  line: number,
  column: number,
): {
  column: number;
  line: number;
  sourceFile: string;
} | undefined {
  const sourceMap = JSON.parse(sourceMapText) as {
    mappings: string;
    sources: string[];
  };
  const mappings = decodeMappings(sourceMap.mappings, sourceMap.sources);
  const lineMappings = mappings.filter((mapping) => mapping.generatedLine === line - 1);
  let best: Mapping | undefined;

  for (const mapping of lineMappings) {
    if (mapping.generatedColumn <= column - 1) {
      best = mapping;
    }
  }

  return best
    ? {
        column: best.sourceColumn + 1,
        line: best.sourceLine + 1,
        sourceFile: best.sourceFile,
      }
    : undefined;
}

function combineBlocks(blocks: string[]): string {
  const text = blocks
    .map((block) => block.trimEnd())
    .filter((block) => block.length > 0)
    .join("\n");

  return text.length === 0 ? "" : `${text}\n`;
}

function blockMappings(
  blocks: SourceMapBlock[],
  sourceTextForFile: (sourceFile: string) => string,
): Mapping[] {
  const mappings: Mapping[] = [];
  let lineOffset = 0;

  for (const block of blocks) {
    const blockText = block.text.trimEnd();

    if (blockText.length === 0) {
      continue;
    }

    mappings.push(...tokenMappingsForBlock(
      blockText,
      block.statements,
      block.sourceFile,
      block.origin,
      sourceTextForFile,
      lineOffset,
    ));
    lineOffset += blockText.split("\n").length;
  }

  return mappings;
}

function tokenMappingsForBlock(
  text: string,
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile | undefined,
  origin: Origin | undefined,
  sourceTextForFile: (sourceFile: string) => string,
  lineOffset: number,
): Mapping[] {
  const generatedTokens = generatedInterestingTokens(text);
  const originTokens = statements.flatMap((statement) =>
    originInterestingTokens(statement, sourceFile, sourceTextForFile)
  );
  const mappings: Mapping[] = origin
    ? defined([mappingForOrigin(origin, 0, lineOffset, sourceTextForFile)])
    : [];
  let generatedIndex = 0;

  for (const originToken of originTokens) {
    const matchedIndex = generatedTokens.findIndex((token, index) =>
      index >= generatedIndex && token.text === originToken.text
    );

    if (matchedIndex < 0) {
      continue;
    }

    const generated = generatedTokens[matchedIndex]!;
    const sourceText = sourceTextForFile(originToken.origin.sourceFile);
    const sourceLocation = new LinesAndColumns(sourceText)
      .locationForIndex(originToken.origin.start);

    if (sourceLocation) {
      mappings.push({
        generatedColumn: generated.column,
        generatedLine: generated.line + lineOffset,
        sourceColumn: sourceLocation.column,
        sourceFile: originToken.origin.sourceFile,
        sourceLine: sourceLocation.line,
      });
    }

    generatedIndex = matchedIndex + 1;
  }

  return mappings;
}

function mappingForOrigin(
  origin: Origin,
  generatedColumn: number,
  generatedLine: number,
  sourceTextForFile: (sourceFile: string) => string,
): Mapping | undefined {
  const sourceText = sourceTextForFile(origin.sourceFile);
  const sourceLocation = new LinesAndColumns(sourceText).locationForIndex(origin.start);

  return sourceLocation
    ? {
        generatedColumn,
        generatedLine,
        sourceColumn: sourceLocation.column,
        sourceFile: origin.sourceFile,
        sourceLine: sourceLocation.line,
      }
    : undefined;
}

function defined<Value>(values: Array<Value | undefined>): Value[] {
  return values.filter((value): value is Value => value !== undefined);
}

/**
 * Extracts the printed tokens we use as source-map anchors.
 * "Interesting" tokens are stable, user-visible syntax with useful diagnostic
 * ownership: identifiers, literals, and TypeScript keywords. Punctuation and
 * operators are deliberately excluded because they are often introduced,
 * removed, or moved by printing and by TypeStage wrappers.
 */
function generatedInterestingTokens(text: string): GeneratedToken[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const lines = new LinesAndColumns(text);
  const tokens: GeneratedToken[] = [];

  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const token = scanner.getToken();

    if (!isInterestingTokenKind(token)) {
      continue;
    }

    const position = scanner.getTokenPos();
    const location = lines.locationForIndex(position);

    if (location) {
      tokens.push({
        column: location.column,
        kind: token,
        line: location.line,
        text: scanner.getTokenText(),
      });
    }
  }

  return tokens;
}

/**
 * Builds source-side token anchors for a residual AST subtree.
 * The fast path scans the node's whole original source range, but only when
 * that range would print to the same interesting-token sequence as the
 * generated node. That preserves keywords the AST does not expose as child
 * nodes, such as `export`, `const`, or `satisfies`. When the token shape does
 * not match, as with splices, hygiene renames, or synthetic adapters, we fall
 * back to the node's own origin and recursively map children so generated
 * tokens keep the more precise origins attached during expansion.
 */
function originInterestingTokens(
  root: ts.Node,
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): OriginToken[] {
  const tokens: OriginToken[] = [];

  const visit = (node: ts.Node) => {
    const origin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);
    const scanOrigin = originForTokenScan(node, sourceFile) ?? origin;

    if (scanOrigin) {
      const sourceTokens = sourceRangeInterestingTokens(scanOrigin, sourceTextForFile);

      if (
        canUseCompleteSourceRangeTokens(
          node,
          scanOrigin,
          sourceTokens,
          sourceFile,
          sourceTextForFile,
        )
      ) {
        tokens.push(...sourceTokens);
        return;
      }

      if (isInterestingTokenKind(node.kind)) {
        const tokenOrigin = origin ?? scanOrigin;

        tokens.push({
          kind: node.kind,
          origin: tokenOrigin,
          text: tokenText(node, sourceFile, sourceTextForFile),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);

  return tokens;
}

function originForTokenScan(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): Origin | undefined {
  const nodeOrigin = getNodeOrigin(node);
  const sourceOrigin = originForSourceNode(node, sourceFile);

  if (
    nodeOrigin &&
    sourceOrigin &&
    sourceOrigin.sourceFile === nodeOrigin.sourceFile &&
    sourceOrigin.start <= nodeOrigin.start &&
    sourceOrigin.end >= nodeOrigin.end
  ) {
    return sourceOrigin;
  }

  return nodeOrigin ?? sourceOrigin;
}

function sourceRangeInterestingTokens(
  origin: Origin,
  sourceTextForFile: (sourceFile: string) => string,
): OriginToken[] {
  const sourceText = sourceTextForFile(origin.sourceFile);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText.slice(origin.start, origin.end),
  );
  const tokens: OriginToken[] = [];

  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const kind = scanner.getToken();

    if (!isInterestingTokenKind(kind)) {
      continue;
    }

    const start = origin.start + scanner.getTokenPos();

    tokens.push({
      kind,
      origin: {
        sourceFile: origin.sourceFile,
        start,
        end: start + scanner.getTokenText().length,
      },
      text: scanner.getTokenText(),
    });
  }

  return tokens;
}

function canUseCompleteSourceRangeTokens(
  node: ts.Node,
  origin: Origin,
  sourceTokens: OriginToken[],
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): boolean {
  if (sourceTokens.length === 0) {
    return false;
  }

  const sourceText = sourceTextForFile(origin.sourceFile)
    .slice(origin.start, origin.end);

  return (
    !sourceText.includes("${") &&
    !sourceText.includes("__typestage_hole_") &&
    hasSameInterestingTokenShape(
      node,
      sourceTokens,
      sourceFile,
    ) &&
    !hasDescendantTokenMismatch(node, origin, sourceFile, sourceTextForFile)
  );
}

function hasSameInterestingTokenShape(
  node: ts.Node,
  sourceTokens: OriginToken[],
  sourceFile: ts.SourceFile | undefined,
): boolean {
  const generatedTokens = generatedNodeInterestingTokens(node, sourceFile);

  return generatedTokens.length === sourceTokens.length &&
    generatedTokens.every((token, index) => {
      const sourceToken = sourceTokens[index]!;

      return token.kind === sourceToken.kind && token.text === sourceToken.text;
    });
}

function generatedNodeInterestingTokens(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): Array<Pick<GeneratedToken, "kind" | "text">> {
  const printed = ts.createPrinter({removeComments: true}).printNode(
    emitHintForNode(node),
    node,
    sourceFile ?? emptySourceFile,
  );

  return generatedInterestingTokens(printed).map((token) => ({
    kind: token.kind,
    text: token.text,
  }));
}

function emitHintForNode(node: ts.Node): ts.EmitHint {
  if (ts.isExpression(node)) {
    return ts.EmitHint.Expression;
  }

  if (ts.isIdentifier(node)) {
    return ts.EmitHint.Expression;
  }

  return ts.EmitHint.Unspecified;
}

function hasDescendantTokenMismatch(
  root: ts.Node,
  origin: Origin,
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): boolean {
  let mismatch = false;

  const visit = (node: ts.Node) => {
    if (mismatch || node === root) {
      ts.forEachChild(node, visit);
      return;
    }

    if (isInterestingTokenKind(node.kind)) {
      const nodeOrigin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);

      if (
        !nodeOrigin ||
        nodeOrigin.sourceFile !== origin.sourceFile ||
        nodeOrigin.start < origin.start ||
        nodeOrigin.end > origin.end
      ) {
        mismatch = true;
        return;
      }

      const sourceTokenText = sourceTextForFile(nodeOrigin.sourceFile)
        .slice(nodeOrigin.start, nodeOrigin.end);
      const generatedTokenText = tokenText(node, sourceFile, sourceTextForFile);

      if (sourceTokenText !== generatedTokenText) {
        mismatch = true;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);

  return mismatch;
}

function originForSourceNode(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): Origin | undefined {
  if (!sourceFile || node.pos < 0 || node.end < 0) {
    return undefined;
  }

  return originForRange(
    sourceFile.fileName,
    node.getStart(sourceFile),
    node.getEnd(),
  );
}

function tokenText(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }

  const origin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);

  if (origin) {
    return node.pos >= 0
      ? sourceTextForFile(origin.sourceFile).slice(origin.start, origin.end)
      : syntheticTokenText(node, sourceFile);
  }

  return sourceFile ? node.getText(sourceFile) : tokenTextForKind(node.kind);
}

function syntheticTokenText(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }

  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
    return node.text;
  }

  if (ts.isStringLiteral(node)) {
    return JSON.stringify(node.text);
  }

  if (ts.isRegularExpressionLiteral(node)) {
    return sourceFile ? node.getText(sourceFile) : "";
  }

  return tokenTextForKind(node.kind);
}

function tokenTextForKind(kind: ts.SyntaxKind): string {
  switch (kind) {
    case ts.SyntaxKind.TrueKeyword:
      return "true";

    case ts.SyntaxKind.FalseKeyword:
      return "false";

    case ts.SyntaxKind.NullKeyword:
      return "null";

    default:
      return ts.tokenToString(kind) ?? "";
  }
}

/** Returns whether a scanner token is useful enough to anchor a mapping. */
function isInterestingTokenKind(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.Identifier ||
    kind === ts.SyntaxKind.NumericLiteral ||
    kind === ts.SyntaxKind.BigIntLiteral ||
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    isKeywordTokenKind(kind)
  );
}

function isKeywordTokenKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword;
}

function encodeMappings(mappings: Mapping[], sourceFiles: string[]): string {
  const sourceIndexes = new Map(sourceFiles.map((sourceFile, index) => [sourceFile, index]));
  const sortedMappings = [...mappings].sort((left, right) =>
    left.generatedLine - right.generatedLine ||
    left.generatedColumn - right.generatedColumn
  );
  const lines: string[][] = [];
  let previousGeneratedLine = 0;
  let previousGeneratedColumn = 0;
  let previousSourceIndex = 0;
  let previousSourceLine = 0;
  let previousSourceColumn = 0;

  for (const mapping of sortedMappings) {
    while (previousGeneratedLine < mapping.generatedLine) {
      lines.push([]);
      previousGeneratedLine++;
      previousGeneratedColumn = 0;
    }

    const sourceIndex = sourceIndexes.get(mapping.sourceFile) ?? 0;
    const line = lines[previousGeneratedLine] ?? [];

    line.push([
      encodeVlq(mapping.generatedColumn - previousGeneratedColumn),
      encodeVlq(sourceIndex - previousSourceIndex),
      encodeVlq(mapping.sourceLine - previousSourceLine),
      encodeVlq(mapping.sourceColumn - previousSourceColumn),
    ].join(""));
    lines[previousGeneratedLine] = line;
    previousGeneratedColumn = mapping.generatedColumn;
    previousSourceIndex = sourceIndex;
    previousSourceLine = mapping.sourceLine;
    previousSourceColumn = mapping.sourceColumn;
  }

  return lines.map((line) => line.join(",")).join(";");
}

function decodeMappings(mappings: string, sourceFiles: string[]): Mapping[] {
  const decoded: Mapping[] = [];
  let previousSourceIndex = 0;
  let previousSourceLine = 0;
  let previousSourceColumn = 0;

  mappings.split(";").forEach((line, generatedLine) => {
    let previousGeneratedColumn = 0;

    for (const segment of line.split(",").filter(Boolean)) {
      const values = decodeVlqSegment(segment);

      if (values.length < 4) {
        continue;
      }

      previousGeneratedColumn += values[0]!;
      previousSourceIndex += values[1]!;
      previousSourceLine += values[2]!;
      previousSourceColumn += values[3]!;
      decoded.push({
        generatedColumn: previousGeneratedColumn,
        generatedLine,
        sourceColumn: previousSourceColumn,
        sourceFile: sourceFiles[previousSourceIndex] ?? "",
        sourceLine: previousSourceLine,
      });
    }
  });

  return decoded;
}

function encodeVlq(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) + 1 : value << 1;
  let text = "";

  do {
    let digit = vlq & 31;

    vlq >>>= 5;

    if (vlq > 0) {
      digit |= 32;
    }

    text += base64Digits[digit];
  } while (vlq > 0);

  return text;
}

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;

  for (const character of segment) {
    const digit = base64Values.get(character) ?? 0;
    const continuation = Boolean(digit & 32);

    value += (digit & 31) << shift;

    if (continuation) {
      shift += 5;
      continue;
    }

    values.push(value & 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }

  return values;
}
