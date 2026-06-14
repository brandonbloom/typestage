import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {
  compileRuntimeModule,
  type CompileGraphResult,
  type Diagnostic,
} from "typestage";
import * as ts from "typescript";
import {compileLisp} from "./compiler.ts";

export type CompileLispToTypeScriptOptions = {
  globals?: string[];
  sourceFile?: string;
  sourceMaps?: boolean;
};

export type CompileLispToTypeScriptResult = {
  graph: CompileGraphResult;
  outputText?: string;
  sourceMapText?: string;
};

export type EvaluationResult = {
  logs: string[];
  result?: unknown;
  resultLabel?: string;
  threw?: unknown;
};

type NamespaceBinding = {
  moduleName: string;
};

export async function compileLispFileToTypeScript(
  inputPath: string,
  options: Omit<CompileLispToTypeScriptOptions, "sourceFile"> = {},
): Promise<CompileLispToTypeScriptResult> {
  const source = await readFile(inputPath, "utf8");

  return compileLispSourceToTypeScript(source, {
    ...options,
    sourceFile: inputPath,
  });
}

export async function compileLispSourceToTypeScript(
  source: string,
  options: CompileLispToTypeScriptOptions = {},
): Promise<CompileLispToTypeScriptResult> {
  const sourceFile = options.sourceFile ?? "repl.lisp";
  const compiled = compileLisp(source, options.globals ?? [], sourceFile);

  if (compiled.diagnostics.length > 0) {
    const graph = await compileRuntimeModule([], {
      diagnostics: compiled.diagnostics.map((diagnostic): Diagnostic => ({
        code: diagnostic.code,
        message: diagnostic.message,
        origin: {
          sourceFile,
          start: diagnostic.span.start,
          end: diagnostic.span.end,
        },
      })),
      outputPath: "main.ts",
      sourceFile: generatedSourceFile(sourceFile),
    });

    return {graph};
  }

  const graph = await compileRuntimeModule(compiled.declarations, {
    outputPath: "main.ts",
    sourceFile: generatedSourceFile(sourceFile),
    sources: {[sourceFile]: source},
    sourceMaps: options.sourceMaps,
  });
  const entryFile = graph.files.find((file) => file.outputPath === "main.ts");

  return {
    graph,
    outputText: entryFile?.outputText,
    sourceMapText: entryFile?.sourceMapText,
  };
}

export async function evaluateTypeScript(outputText: string): Promise<EvaluationResult> {
  const runtime = await ReplRuntime.create();

  try {
    return await runtime.evaluate(outputText);
  } finally {
    await runtime.dispose();
  }
}

export class ReplRuntime {
  private readonly namespace = new Map<string, NamespaceBinding>();
  private readonly tempRoot: string;
  private nextModuleIndex = 0;

  static async create(): Promise<ReplRuntime> {
    return new ReplRuntime(await mkdtemp(join(tmpdir(), "typestage-lisp-eval-")));
  }

  private constructor(tempRoot: string) {
    this.tempRoot = tempRoot;
  }

  async evaluate(outputText: string): Promise<EvaluationResult> {
    const moduleName = `step-${this.nextModuleIndex}.ts`;
    const modulePath = join(this.tempRoot, moduleName);
    const exportedNames = exportedBindingNames(outputText);
    const moduleText = `${this.importSource(exportedNames)}${outputText}`;
    const evaluation = await evaluateModule(modulePath, moduleText);

    for (const name of exportedNames) {
      this.namespace.set(name, {moduleName});
    }

    this.nextModuleIndex++;

    return evaluation;
  }

  async dispose() {
    await rm(this.tempRoot, {force: true, recursive: true});
  }

  bindingNames(): string[] {
    return Array.from(this.namespace.keys()).sort();
  }

  private importSource(exportedNames: Set<string>): string {
    const importsByModule = new Map<string, string[]>();

    for (const [name, binding] of this.namespace.entries()) {
      if (exportedNames.has(name)) {
        continue;
      }

      const names = importsByModule.get(binding.moduleName) ?? [];

      names.push(name);
      importsByModule.set(binding.moduleName, names);
    }

    return Array.from(importsByModule.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([moduleName, names]) =>
        `import {${names.sort().join(", ")}} from ${JSON.stringify(`./${moduleName}`)};\n`
      )
      .join("");
  }
}

async function evaluateModule(
  modulePath: string,
  moduleText: string,
): Promise<EvaluationResult> {
  const logs: string[] = [];
  const originalLog = console.log;

  console.log = (...values: unknown[]) => {
    logs.push(values.map(formatLogValue).join(" "));
  };

  try {
    await writeFile(modulePath, moduleText);

    try {
      const exports = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`) as Record<string, unknown>;

      const latestResultName = latestGeneratedResultName(exports);

      if (latestResultName) {
        return {
          logs,
          result: exports[latestResultName],
          resultLabel: latestResultName,
        };
      }

      if ("result" in exports) {
        return {
          logs,
          result: exports.result,
          resultLabel: "result",
        };
      }

      if (typeof exports.main === "function") {
        return {
          logs,
          result: await exports.main(),
          resultLabel: "main",
        };
      }

      return {
        logs,
        result: null,
        resultLabel: "define",
      };
    } catch (error) {
      return {logs, threw: error};
    }
  } finally {
    console.log = originalLog;
  }
}

function formatLogValue(value: unknown): string {
  return formatJsonValue(value);
}

function generatedSourceFile(sourceFile: string): string {
  return `${sourceFile}.generated.ts`;
}

function latestGeneratedResultName(exports: Record<string, unknown>): string | undefined {
  return Object.keys(exports)
    .map((name) => {
      const match = /^result(\d+)$/.exec(name);

      return match ? {index: Number(match[1]), name} : undefined;
    })
    .filter((candidate): candidate is {index: number; name: string} =>
      candidate !== undefined
    )
    .sort((left, right) => right.index - left.index)[0]?.name;
}

export function formatJsonValue(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  const json = JSON.stringify(value, null, 2);

  return json === undefined ? String(value) : json;
}

function exportedBindingNames(sourceText: string): Set<string> {
  const sourceFile = ts.createSourceFile(
    "repl-output.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        collectBindingNames(declaration.name, names);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }

  return names;
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) =>
      modifier.kind === ts.SyntaxKind.ExportKeyword
    );
}

function collectBindingNames(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      collectBindingNames(element.name, names);
    }
  }
}
