import {describe, expect, test} from "bun:test";
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, relative, resolve} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import {compileFileGraph} from "../src/index.ts";
import {originalPositionForGeneratedLocation} from "../src/source-map.ts";
import type {Diagnostic} from "../src/index.ts";

const fixturesRoot = join(import.meta.dir, "fixtures", "pass");
const expectedFailuresRoot = join(import.meta.dir, "fixtures", "fail");
const typecheckFixturesRoot = join(import.meta.dir, "fixtures", "typecheck");

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

describe("TypeStage typecheck fixtures", () => {
  for (const caseName of typecheckFixtureCaseNames()) {
    test(caseName, async () => {
      await assertTypecheckFixture(caseName);
    });
  }
});

function fixtureCaseNames(): string[] {
  return caseNamesIn(fixturesRoot);
}

function expectedFailureCaseNames(): string[] {
  return caseNamesIn(expectedFailuresRoot);
}

function typecheckFixtureCaseNames(): string[] {
  return caseNamesIn(typecheckFixturesRoot);
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

async function assertTypecheckFixture(caseName: string) {
  const caseRoot = join(typecheckFixturesRoot, caseName);
  const result = await compileFileGraph(entryPath(caseRoot), {
    sourceMaps: true,
    sourceRoot: join(caseRoot, "input"),
  });

  expect(formatGraphDiagnostics(result.diagnostics)).toEqual("No diagnostics.\n");
  assertGeneratedTree(
    join(caseRoot, "output"),
    result.files.flatMap((file) => [
      [file.outputPath, normalizeOutput(file.outputText)] as [string, string],
      ...(file.sourceMapPath && file.sourceMapText
        ? [[file.sourceMapPath, normalizeOutput(file.sourceMapText)] as [string, string]]
        : []),
    ]),
  );
  assertGeneratedFiles(caseRoot, [
    ["typecheck-diagnostics.txt", runTypecheck(result.files)],
  ]);
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

function runTypecheck(
  files: Array<{
    outputPath: string;
    outputText: string;
    sourceMapPath?: string;
    sourceMapText?: string;
  }>,
): string {
  const tempRoot = mkdtempSync(join(tmpdir(), "typestage-typecheck-"));

  try {
    const sourceMapsByOutputPath = new Map<string, string>();

    for (const file of files) {
      const outputPath = join(tempRoot, file.outputPath);

      mkdirSync(dirname(outputPath), {recursive: true});
      writeFileSync(outputPath, file.outputText);

      if (file.sourceMapPath && file.sourceMapText) {
        const sourceMapPath = join(tempRoot, file.sourceMapPath);

        mkdirSync(dirname(sourceMapPath), {recursive: true});
        writeFileSync(sourceMapPath, file.sourceMapText);
        sourceMapsByOutputPath.set(resolve(outputPath), file.sourceMapText);
        sourceMapsByOutputPath.set(outputPath, file.sourceMapText);
        sourceMapsByOutputPath.set(file.outputPath, file.sourceMapText);
        sourceMapsByOutputPath.set(basename(file.outputPath), file.sourceMapText);
      }
    }

    writeFileSync(
      join(tempRoot, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          lib: ["ES2024"],
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          strict: true,
          target: "ES2024",
        },
        include: ["**/*.ts"],
      }, null, 2)}\n`,
    );

    const result = spawnSync(
      join(import.meta.dir, "..", "node_modules", ".bin", "tsgo"),
      ["--pretty", "false", "-p", join(tempRoot, "tsconfig.json")],
      {
        cwd: tempRoot,
        encoding: "utf8",
      },
    );

    if (result.error) {
      throw result.error;
    }

    const output = `${result.stdout}${result.stderr}`.trim();

    if (!output) {
      if (result.status && result.status !== 0) {
        throw new Error(`tsgo exited with status ${result.status} and no diagnostics`);
      }

      return "No diagnostics.\n";
    }

    return output
      .split("\n")
      .map((line) => remapTypecheckDiagnostic(line, tempRoot, sourceMapsByOutputPath))
      .join("\n")
      .concat("\n");
  } finally {
    rmSync(tempRoot, {force: true, recursive: true});
  }
}

function remapTypecheckDiagnostic(
  line: string,
  tempRoot: string,
  sourceMapsByOutputPath: Map<string, string>,
): string {
  const match = /^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);

  if (!match) {
    return line;
  }

  const [, generatedFile, lineText, columnText, code, message] = match;
  const generatedPath = resolve(tempRoot, generatedFile!);
  const sourceMapText =
    sourceMapsByOutputPath.get(generatedPath) ??
    sourceMapsByOutputPath.get(relative(tempRoot, generatedPath)) ??
    sourceMapsByOutputPath.get(generatedFile!) ??
    sourceMapsByOutputPath.get(basename(generatedFile!));
  const original = sourceMapText
    ? originalPositionForGeneratedLocation(
        sourceMapText,
        Number(lineText),
        Number(columnText),
      )
    : undefined;

  return original
    ? `${original.sourceFile}:${original.line}:${original.column} TS${code}: ${message}`
    : `${generatedFile}:${lineText}:${columnText} TS${code}: ${message}`;
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
