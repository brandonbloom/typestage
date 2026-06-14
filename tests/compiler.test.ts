import {describe, expect, test} from "bun:test";
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import {compileFileGraph} from "../src/index.ts";
import type {Diagnostic} from "../src/index.ts";

const fixturesRoot = join(import.meta.dir, "fixtures", "pass");
const expectedFailuresRoot = join(import.meta.dir, "fixtures", "fail");

describe("TypeStage pass fixtures", () => {
  for (const caseName of fixtureCaseNames()) {
    test(caseName, async () => {
      await assertFixture(caseName);
    });
  }
});

describe("TypeStage fail fixtures", () => {
  for (const caseName of expectedFailureCaseNames()) {
    test(caseName, async () => {
      await assertExpectedFailureFixture(caseName);
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
    .filter((entry) => existsSync(join(root, entry.name, "input", "main.ts")))
    .map((entry) => entry.name)
    .sort();
}

async function assertFixture(caseName: string) {
  const caseRoot = join(fixturesRoot, caseName);

  await assertGraphFixture(caseRoot);
}

async function assertGraphFixture(caseRoot: string) {
  const result = await compileFileGraph(entryPath(caseRoot), {
    sourceRoot: join(caseRoot, "input"),
  });

  assertGeneratedTree(
    join(caseRoot, "output"),
    result.files.map((file) => [file.outputPath, normalizeOutput(file.outputText)]),
  );
  assertGeneratedFiles(caseRoot, [
    ["diagnostics.txt", formatGraphDiagnostics(result.diagnostics)],
    ["pipeline.json", `${JSON.stringify(result.pipeline, null, 2)}\n`],
  ]);
}

async function assertExpectedFailureFixture(caseName: string) {
  const caseRoot = join(expectedFailuresRoot, caseName);

  await assertExpectedFailureGraphFixture(caseRoot);
}

async function assertExpectedFailureGraphFixture(caseRoot: string) {
  const result = await compileFileGraph(entryPath(caseRoot), {
    sourceRoot: join(caseRoot, "input"),
  });
  const actualFiles: Array<[fileName: string, actual: string]> = [
    ["diagnostics.txt", formatGraphDiagnostics(result.diagnostics)],
    ["pipeline.json", `${JSON.stringify(result.pipeline, null, 2)}\n`],
  ];

  assertGeneratedTree(
    join(caseRoot, "output"),
    result.files.map((file) => [file.outputPath, normalizeOutput(file.outputText)]),
  );
  assertGeneratedFiles(caseRoot, actualFiles);

  const desiredMismatches = [
    ...desiredFileMismatches(caseRoot, actualFiles),
    ...desiredTreeMismatches(
      join(caseRoot, "desired-output"),
      result.files.map((file) => [file.outputPath, normalizeOutput(file.outputText)]),
    ),
  ];

  expect(desiredMismatches).not.toEqual([]);
}

function entryPath(caseRoot: string): string {
  return join(caseRoot, "input", "main.ts");
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

function assertGeneratedTree(
  root: string,
  files: Array<[fileName: string, actual: string]>,
) {
  mkdirSync(root, {recursive: true});

  const expectedNames = new Set(files.map(([fileName]) => fileName));
  const existingNames = new Set(existingFiles(root));
  const mismatches: string[] = [];

  for (const [fileName, actual] of files) {
    const outputPath = join(root, fileName);
    const expected = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";

    mkdirSync(dirname(outputPath), {recursive: true});
    writeFileSync(outputPath, actual);

    if (actual !== expected) {
      mismatches.push(fileName);
    }
  }

  for (const existingName of existingNames) {
    if (!expectedNames.has(existingName)) {
      mismatches.push(existingName);
    }
  }

  expect(mismatches.sort()).toEqual([]);
}

function existingFiles(root: string, prefix = ""): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, {withFileTypes: true}).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, entry.name);

    return entry.isDirectory() ? existingFiles(path, name) : [name];
  });
}

function normalizeOutput(outputText: string): string {
  return outputText.length === 0 ? "" : `${outputText.trimEnd()}\n`;
}

function desiredFileMismatches(
  caseRoot: string,
  actualFiles: Array<[fileName: string, actual: string]>,
): string[] {
  return actualFiles
    .filter(([fileName, actual]) => {
      const desiredPath = join(caseRoot, `desired-${fileName}`);

      return existsSync(desiredPath) && readFileSync(desiredPath, "utf8") !== actual;
    })
    .map(([fileName]) => fileName);
}

function desiredTreeMismatches(
  desiredRoot: string,
  actualFiles: Array<[fileName: string, actual: string]>,
): string[] {
  if (!existsSync(desiredRoot)) {
    return [];
  }

  const actualByName = new Map(actualFiles);
  const mismatches: string[] = [];

  for (const fileName of existingFiles(desiredRoot)) {
    const desired = readFileSync(join(desiredRoot, fileName), "utf8");

    if (actualByName.get(fileName) !== desired) {
      mismatches.push(`output/${fileName}`);
    }
  }

  for (const fileName of actualByName.keys()) {
    if (!existsSync(join(desiredRoot, fileName))) {
      mismatches.push(`output/${fileName}`);
    }
  }

  return mismatches.sort();
}

function formatGraphDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No diagnostics.\n";
  }

  const sourceTexts = new Map<string, string>();

  return diagnostics
    .map((diagnostic) => {
      if (!diagnostic.origin) {
        return `${diagnostic.code}: ${diagnostic.message}`;
      }

      const sourceText = sourceTexts.get(diagnostic.origin.sourceFile) ??
        readFileSync(diagnostic.origin.sourceFile, "utf8");

      sourceTexts.set(diagnostic.origin.sourceFile, sourceText);

      return formatDiagnostic(sourceText, diagnostic);
    })
    .join("\n")
    .concat("\n");
}

function formatDiagnostic(
  sourceText: string,
  diagnostic: Diagnostic,
  lines = new LinesAndColumns(sourceText),
): string {
  if (!diagnostic.origin) {
    return `${diagnostic.code}: ${diagnostic.message}`;
  }

  const location = lines.locationForIndex(diagnostic.origin.start);
  const line = location ? location.line + 1 : 0;
  const column = location ? location.column + 1 : 0;

  return `${diagnostic.origin.sourceFile}:${line}:${column} ${diagnostic.code}: ${diagnostic.message}`;
}
