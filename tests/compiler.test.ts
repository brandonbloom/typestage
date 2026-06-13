import {describe, expect, test} from "bun:test";
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import {compileSource, snapshotPipeline} from "../src/index.ts";
import type {Diagnostic} from "../src/index.ts";

const fixturesRoot = join(import.meta.dir, "fixtures", "cases");
const expectedFailuresRoot = join(import.meta.dir, "fixtures", "expected-fail");

describe("TypeStage fixture cases", () => {
  for (const caseName of fixtureCaseNames()) {
    test(caseName, () => {
      assertFixture(caseName);
    });
  }
});

describe("TypeStage expected-failure fixtures", () => {
  for (const caseName of expectedFailureCaseNames()) {
    test(caseName, () => {
      assertExpectedFailureFixture(caseName);
    });
  }
});

function fixtureCaseNames(): string[] {
  return caseNamesIn(fixturesRoot);
}

function expectedFailureCaseNames(): string[] {
  return caseNamesIn(expectedFailuresRoot);
}

function caseNamesIn(root: string): string[] {
  return readdirSync(root, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(root, entry.name, "input.ts")))
    .map((entry) => entry.name)
    .sort();
}

function assertFixture(caseName: string) {
  const caseRoot = join(fixturesRoot, caseName);
  const sourcePath = join(caseRoot, "input.ts");
  const fixtureFileName = relative(process.cwd(), sourcePath);
  const sourceText = readFileSync(sourcePath, "utf8");
  const result = compileSource(sourceText, fixtureFileName);
  const pipeline = snapshotPipeline(sourceText, fixtureFileName);

  assertGeneratedFiles(caseRoot, [
    ["output.ts", normalizeOutput(result.outputText)],
    ["diagnostics.txt", formatDiagnostics(sourceText, result.diagnostics)],
    ["pipeline.json", `${JSON.stringify(pipeline, null, 2)}\n`],
  ]);
}

function assertExpectedFailureFixture(caseName: string) {
  const caseRoot = join(expectedFailuresRoot, caseName);
  const sourcePath = join(caseRoot, "input.ts");
  const fixtureFileName = relative(process.cwd(), sourcePath);
  const sourceText = readFileSync(sourcePath, "utf8");
  const result = compileSource(sourceText, fixtureFileName);
  const pipeline = snapshotPipeline(sourceText, fixtureFileName);
  const actualFiles: Array<[fileName: string, actual: string]> = [
    ["output.ts", normalizeOutput(result.outputText)],
    ["diagnostics.txt", formatDiagnostics(sourceText, result.diagnostics)],
    ["pipeline.json", `${JSON.stringify(pipeline, null, 2)}\n`],
  ];

  assertGeneratedFiles(caseRoot, actualFiles);

  const desiredMismatches = actualFiles
    .filter(([fileName, actual]) => {
      const desiredPath = join(caseRoot, `desired-${fileName}`);

      return existsSync(desiredPath) && readFileSync(desiredPath, "utf8") !== actual;
    })
    .map(([fileName]) => fileName);

  expect(desiredMismatches).not.toEqual([]);
}

function assertGeneratedFiles(
  caseRoot: string,
  files: Array<[fileName: string, actual: string]>,
) {
  mkdirSync(caseRoot, {recursive: true});

  const mismatches: string[] = [];

  for (const [fileName, actual] of files) {
    const outputPath = join(caseRoot, fileName);
    const expected = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";

    writeFileSync(outputPath, actual);

    if (actual !== expected) {
      mismatches.push(fileName);
    }
  }

  expect(mismatches).toEqual([]);
}

function normalizeOutput(outputText: string): string {
  return outputText.length === 0 ? "" : `${outputText.trimEnd()}\n`;
}

function formatDiagnostics(
  sourceText: string,
  diagnostics: Diagnostic[],
): string {
  if (diagnostics.length === 0) {
    return "No diagnostics.\n";
  }

  const lines = new LinesAndColumns(sourceText);

  return diagnostics
    .map((diagnostic) => {
      if (!diagnostic.origin) {
        return `${diagnostic.code}: ${diagnostic.message}`;
      }

      const location = lines.locationForIndex(diagnostic.origin.start);
      const line = location ? location.line + 1 : 0;
      const column = location ? location.column + 1 : 0;

      return `${diagnostic.origin.sourceFile}:${line}:${column} ${diagnostic.code}: ${diagnostic.message}`;
    })
    .join("\n")
    .concat("\n");
}
