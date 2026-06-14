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
  line: number;
  text: string;
};

type OriginToken = {
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
  sourceTextForFile: (sourceFile: string) => string,
  lineOffset: number,
): Mapping[] {
  const generatedTokens = generatedInterestingTokens(text);
  const originTokens = statements.flatMap((statement) =>
    originInterestingTokens(statement, sourceFile, sourceTextForFile)
  );
  const mappings: Mapping[] = [];
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
        line: location.line,
        text: scanner.getTokenText(),
      });
    }
  }

  return tokens;
}

function originInterestingTokens(
  root: ts.Node,
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): OriginToken[] {
  const tokens: OriginToken[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) {
      const origin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);

      if (origin) {
        tokens.push({
          origin: {
            sourceFile: origin.sourceFile,
            start: origin.start,
            end: origin.start + "return".length,
          },
          text: "return",
        });
      }
    }

    if (isInterestingTokenKind(node.kind)) {
      const origin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);

      if (origin) {
        tokens.push({
          origin,
          text: tokenText(node, sourceFile, sourceTextForFile),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);

  return tokens;
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
    case ts.SyntaxKind.ReturnKeyword:
      return "return";

    case ts.SyntaxKind.TrueKeyword:
      return "true";

    case ts.SyntaxKind.FalseKeyword:
      return "false";

    case ts.SyntaxKind.NullKeyword:
      return "null";

    case ts.SyntaxKind.StringKeyword:
      return "string";

    case ts.SyntaxKind.NumberKeyword:
      return "number";

    case ts.SyntaxKind.BooleanKeyword:
      return "boolean";

    default:
      return "";
  }
}

function isInterestingTokenKind(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.Identifier ||
    kind === ts.SyntaxKind.NumericLiteral ||
    kind === ts.SyntaxKind.BigIntLiteral ||
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    kind === ts.SyntaxKind.TrueKeyword ||
    kind === ts.SyntaxKind.FalseKeyword ||
    kind === ts.SyntaxKind.NullKeyword ||
    kind === ts.SyntaxKind.StringKeyword ||
    kind === ts.SyntaxKind.NumberKeyword ||
    kind === ts.SyntaxKind.BooleanKeyword ||
    kind === ts.SyntaxKind.ReturnKeyword
  );
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
