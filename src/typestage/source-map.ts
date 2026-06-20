/**
 * Source map generation and lookup for residual TypeScript.
 * The graph emitter prints TypeScript ASTs into output blocks. Source-map
 * anchors locate origin-bearing syntax inside those blocks; this module writes
 * standard v3 mappings that external tools can consume or TypeStage tests can
 * remap diagnostics through after running an external checker.
 */
import {basename} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import type * as ts from "typescript";
import {sourceMapAnchorsForBlock} from "./source-map-anchors.ts";
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

export type SourceMapOptions = {
  sourceFileName?: (sourceFile: string) => string;
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
  options: SourceMapOptions = {},
): SourceMappedOutput {
  const outputText = combineBlocks(blocks.map((block) => block.text));
  const mappings = blockMappings(blocks, sourceTextForFile);
  const sourceFileName = options.sourceFileName ?? ((sourceFile: string) => sourceFile);
  const displaySourceText = new Map<string, string>();
  const displayMappings = mappings.map((mapping) => {
    const displaySourceFile = sourceFileName(mapping.sourceFile);

    if (!displaySourceText.has(displaySourceFile)) {
      displaySourceText.set(
        displaySourceFile,
        sourceTextForFile(mapping.sourceFile),
      );
    }

    return {
      ...mapping,
      sourceFile: displaySourceFile,
    };
  });
  const sourceFiles = Array.from(displaySourceText.keys());

  return {
    outputText,
    sourceMapText: `${JSON.stringify({
      version: 3,
      file: basename(outputPath),
      sources: sourceFiles,
      sourcesContent: sourceFiles.map((sourceFile) =>
        displaySourceText.get(sourceFile) ?? ""
      ),
      names: [],
      mappings: encodeMappings(displayMappings, sourceFiles),
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

    mappings.push(...anchorMappingsForBlock(
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

function anchorMappingsForBlock(
  text: string,
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile | undefined,
  origin: Origin | undefined,
  sourceTextForFile: (sourceFile: string) => string,
  lineOffset: number,
): Mapping[] {
  return defined(sourceMapAnchorsForBlock(
    {origin, sourceFile, statements, text},
    sourceTextForFile,
  ).map((anchor) =>
    mappingForOrigin(
      anchor.origin,
      anchor.generatedColumn,
      anchor.generatedLine + lineOffset,
      sourceTextForFile,
    )
  ));
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
