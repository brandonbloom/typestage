import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, relative, resolve, sep} from "node:path";
import {pathToFileURL} from "node:url";
import {compileFileGraph, type CompileGraphResult} from "typestage";
import * as ts from "typescript";

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

const lispRoot = resolve(import.meta.dir, "..");
const compilerPath = resolve(import.meta.dir, "compiler.ts");

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
  const tempRoot = await mkdtemp(join(lispRoot, ".tmp-"));
  const entryPath = join(tempRoot, "main.ts");

  try {
    await writeFile(entryPath, stagingSource(tempRoot, source, options));

    const graph = await compileFileGraph(entryPath, {
      sourceMaps: options.sourceMaps,
      sourceRoot: lispRoot,
    });
    const entryOutputPath = relative(lispRoot, entryPath).split(sep).join("/");
    const entryFile = graph.files.find((file) => file.outputPath === entryOutputPath);

    return {
      graph,
      outputText: entryFile?.outputText,
      sourceMapText: entryFile?.sourceMapText,
    };
  } finally {
    await rm(tempRoot, {force: true, recursive: true});
  }
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

function stagingSource(
  tempRoot: string,
  source: string,
  options: CompileLispToTypeScriptOptions,
): string {
  const compilerImport = relativeImport(tempRoot, compilerPath);
  const sourceFile = options.sourceFile ?? "repl.lisp";

  return `import {q} from "typestage";
import {compileProgram} from ${JSON.stringify(compilerImport)};

const source = ${JSON.stringify(source)};
const sourceFile = ${JSON.stringify(sourceFile)};
const globals = ${JSON.stringify(options.globals ?? [])};

export const program = q.decls\`
  \${compileProgram(source, sourceFile, globals)}
\`;
`;
}

function relativeImport(fromDirectory: string, toPath: string): string {
  const specifier = relative(fromDirectory, toPath).split(sep).join("/");

  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function formatLogValue(value: unknown): string {
  return formatJsonValue(value);
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
