import {LinesAndColumns} from "lines-and-columns";
import * as ts from "typescript";
import {compileVirtualGraph} from "../typestage/graph.ts";
import {originalPositionForGeneratedLocation} from "../typestage/source-map.ts";
import type {CompileGraphFile, Diagnostic} from "../typestage/types.ts";
import type {
  CompileRequest,
  CompileResult,
  ExampleFile,
  PlaygroundDiagnostic,
} from "./protocol.ts";

const sourceRoot = "/playground";

export async function compilePlaygroundRequest(
  request: CompileRequest,
): Promise<CompileResult> {
  const files = request.files?.length
    ? request.files
    : [{fileName: "main.ts", source: ""}];

  return compilePlaygroundGraph(
    files,
    request.entryFileName ?? files[0]?.fileName ?? "main.ts",
  );
}

export async function compilePlaygroundGraph(
  files: ExampleFile[],
  entryFileName: string,
): Promise<CompileResult> {
  try {
    const result = await compileVirtualGraph(files, entryFileName, {
      sourceMaps: true,
      sourceRoot,
    });
    const sourceByFileName = new Map(files.map((file) => [file.fileName, file.source]));
    const graphDiagnostics = playgroundSourceDiagnostics(result.diagnostics);
    const typecheck = result.diagnostics.length === 0
      ? typecheckPlaygroundOutput(sourceByFileName, result.files)
      : {diagnostics: [], textLines: []};
    const diagnosticLines = [
      ...formatGraphDiagnosticLines(sourceByFileName, result.diagnostics),
      ...typecheck.textLines,
    ];

    return {
      diagnostics: diagnosticLines.length > 0 ? diagnosticLines.join("\n") : "No diagnostics.",
      outputFiles: result.files.flatMap((file) => [
        {
          fileName: file.outputPath,
          outputText: file.outputText,
        },
        ...(file.sourceMapPath && file.sourceMapText
          ? [{
              fileName: file.sourceMapPath,
              outputText: file.sourceMapText,
            }]
          : []),
      ]),
      outputText: result.files.find((file) => file.outputPath === entryFileName)?.outputText ?? "",
      sourceDiagnostics: [
        ...graphDiagnostics,
        ...typecheck.diagnostics,
      ],
    };
  } catch (error) {
    return playgroundErrorResult(error);
  }
}

export function playgroundErrorResult(error: unknown): CompileResult {
  return {
    diagnostics: `Internal Error: ${errorMessage(error)}`,
    outputFiles: [],
    outputText: "",
    sourceDiagnostics: [],
  };
}

function formatGraphDiagnosticLines(
  sourceByFileName: Map<string, string>,
  diagnostics: Diagnostic[],
): string[] {
  return diagnostics.map((diagnostic) => {
    if (!diagnostic.origin) {
      return `${diagnostic.code}: ${diagnostic.message}`;
    }

    const fileName = sourceFileNameForDiagnostic(diagnostic.origin.sourceFile);
    const sourceText = sourceByFileName.get(fileName) ?? "";
    const lines = new LinesAndColumns(sourceText);
    const location = lines.locationForIndex(diagnostic.origin.start);
    const line = location ? location.line + 1 : 0;
    const column = location ? location.column + 1 : 0;

    return `${fileName}:${line}:${column} ${diagnostic.code}: ${diagnostic.message}`;
  });
}

function playgroundSourceDiagnostics(
  diagnostics: Diagnostic[],
): PlaygroundDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnostic.origin) {
      return [];
    }

    return [{
      code: diagnostic.code,
      fileName: sourceFileNameForDiagnostic(diagnostic.origin.sourceFile),
      from: diagnostic.origin.start,
      message: diagnostic.message,
      severity: "error" as const,
      to: diagnostic.origin.end,
    }];
  });
}

function typecheckPlaygroundOutput(
  sourceByFileName: Map<string, string>,
  files: CompileGraphFile[],
): {
  diagnostics: PlaygroundDiagnostic[];
  textLines: string[];
} {
  const sourceMapsByOutputPath = new Map<string, string>();
  const sourceTextsByOutputPath = new Map<string, string>();

  for (const file of files) {
    sourceTextsByOutputPath.set(file.outputPath, file.outputText);

    if (file.sourceMapPath && file.sourceMapText) {
      sourceMapsByOutputPath.set(file.outputPath, file.sourceMapText);
      sourceMapsByOutputPath.set(file.sourceMapPath, file.sourceMapText);
    }
  }

  const compilerOptions: ts.CompilerOptions = {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    strict: true,
    target: ts.ScriptTarget.ES2024,
  };
  const program = ts.createProgram({
    rootNames: [...sourceTextsByOutputPath.keys(), "lib.d.ts"],
    options: compilerOptions,
    host: virtualTypecheckHost(sourceTextsByOutputPath),
  });

  return ts.getPreEmitDiagnostics(program).reduce<{
    diagnostics: PlaygroundDiagnostic[];
    textLines: string[];
  }>((summary, diagnostic) => {
    const remapped = remapTypecheckDiagnostic(
      diagnostic,
      sourceByFileName,
      sourceMapsByOutputPath,
    );

    summary.textLines.push(remapped.textLine);

    if (remapped.sourceDiagnostic) {
      summary.diagnostics.push(remapped.sourceDiagnostic);
    }

    return summary;
  }, {diagnostics: [], textLines: []});
}

function virtualTypecheckHost(sourceTextsByOutputPath: Map<string, string>): ts.CompilerHost {
  const libText = playgroundLibText();
  const readFile = (fileName: string) =>
    fileName === "lib.d.ts" ? libText : sourceTextsByOutputPath.get(fileName);

  return {
    fileExists: (fileName) => readFile(fileName) !== undefined,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile(fileName, languageVersion) {
      const text = readFile(fileName);

      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    readFile,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
}

function remapTypecheckDiagnostic(
  diagnostic: ts.Diagnostic,
  sourceByFileName: Map<string, string>,
  sourceMapsByOutputPath: Map<string, string>,
): {
  sourceDiagnostic?: PlaygroundDiagnostic;
  textLine: string;
} {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  const code = `TS${diagnostic.code}`;

  if (!diagnostic.file || diagnostic.start === undefined) {
    return {textLine: `${code}: ${message}`};
  }

  const generatedFile = diagnostic.file.fileName;
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const generatedLine = location.line + 1;
  const generatedColumn = location.character + 1;
  const sourceMapText = sourceMapsByOutputPath.get(generatedFile);
  const original = sourceMapText
    ? originalPositionForGeneratedLocation(
        sourceMapText,
        generatedLine,
        generatedColumn,
      )
    : undefined;

  if (!original) {
    return {
      textLine: `${generatedFile}:${generatedLine}:${generatedColumn} ${code}: ${message}`,
    };
  }

  const fileName = sourceFileNameForDiagnostic(original.sourceFile);
  const sourceText = sourceByFileName.get(fileName) ?? "";
  const index = new LinesAndColumns(sourceText).indexForLocation({
    column: original.column - 1,
    line: original.line - 1,
  });
  const from = index ?? 0;
  const to = diagnosticEnd(sourceText, from);

  return {
    sourceDiagnostic: {
      code,
      fileName,
      from,
      message,
      severity: "error",
      to,
    },
    textLine: `${fileName}:${original.line}:${original.column} ${code}: ${message}`,
  };
}

function sourceFileNameForDiagnostic(sourceFile: string): string {
  return sourceFile
    .replace(/^\/?playground\//u, "")
    .replace(/^.*\/input\//u, "");
}

function diagnosticEnd(sourceText: string, start: number): number {
  let end = start;

  while (end < sourceText.length && /[$\w]/u.test(sourceText[end]!)) {
    end++;
  }

  return end > start ? end : Math.min(sourceText.length, start + 1);
}

function playgroundLibText(): string {
  // The static playground typechecks inside a browser worker, where the
  // TypeScript package's lib files are not available through a filesystem host.
  // This ambient surface is intentionally small: enough globals for examples
  // while still surfacing user-code errors in the generated TypeStage output.
  return `
declare const console: { log(...values: unknown[]): void; error(...values: unknown[]): void; warn(...values: unknown[]): void };
declare const Infinity: number;
declare const NaN: number;
declare const Symbol: { for(key: string): symbol; keyFor(symbol: symbol): string | undefined; (description?: string): symbol };
declare const JSON: { stringify(value: unknown): string; parse(text: string): unknown };
declare class Error { constructor(message?: string); message: string; }
declare class Date { constructor(value?: string | number); toISOString(): string; }
declare class Map<K, V> { constructor(entries?: readonly (readonly [K, V])[]); get(key: K): V | undefined; set(key: K, value: V): this; }
declare class Set<T> { constructor(values?: readonly T[]); add(value: T): this; has(value: T): boolean; }
declare class RegExp { constructor(pattern: string, flags?: string); }
declare interface Array<T> { length: number; [index: number]: T; map<U>(callback: (value: T, index: number) => U): U[]; filter(callback: (value: T, index: number) => boolean): T[]; join(separator?: string): string; }
declare interface ReadonlyArray<T> { readonly length: number; readonly [index: number]: T; map<U>(callback: (value: T, index: number) => U): U[]; filter(callback: (value: T, index: number) => boolean): T[]; join(separator?: string): string; }
declare interface String { length: number; slice(start?: number, end?: number): string; replace(pattern: RegExp | string, replacement: string): string; startsWith(search: string): boolean; endsWith(search: string): boolean; split(separator: string | RegExp): string[]; }
declare interface Number {}
declare interface Boolean {}
declare interface Object {}
declare interface Function {}
declare interface CallableFunction extends Function {}
declare interface NewableFunction extends Function {}
declare interface IArguments {}
`.trimStart();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
