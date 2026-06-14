/** Node.js filesystem wrappers around the browser-safe graph compiler core. */
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {
  dirname as dirnamePath,
  isAbsolute as isAbsolutePath,
  join as joinPath,
  normalize as normalizePath,
} from "pathe";
import {
  compileGraph,
  formatGraphDiagnostics as formatGraphDiagnosticsWithReader,
  type CompileFileGraphOptions,
  type GraphSourceHost,
} from "./graph.ts";
import {evaluateNodeStagingGraph} from "./staging-nodejs.ts";
import type {CompileGraphResult, Diagnostic} from "./types.ts";

export type {CompileFileGraphOptions} from "./graph.ts";

/** Compiles a TypeStage entry file and its local module graph. */
export async function compileFileGraph(
  entryPath: string,
  options: CompileFileGraphOptions = {},
): Promise<CompileGraphResult> {
  const currentDirectory = normalizeNodePath(process.cwd());
  const entryAbsolutePath = normalizeNodePath(resolve(entryPath));
  const sourceRoot = normalizeNodePath(resolve(
    options.sourceRoot ?? dirname(entryAbsolutePath),
  ));

  return compileGraph(entryAbsolutePath, nodeSourceHost(currentDirectory), {
    currentDirectory,
    sourceMaps: options.sourceMaps,
    sourceRoot,
    stagingEvaluator: evaluateNodeStagingGraph,
  });
}

/** Emits a compiled TypeStage module graph into an output directory. */
export async function emitFileGraph(
  entryPath: string,
  outDir: string,
  options: CompileFileGraphOptions = {},
): Promise<CompileGraphResult> {
  const result = await compileFileGraph(entryPath, options);

  if (result.diagnostics.length > 0) {
    return result;
  }

  for (const file of result.files) {
    const outputPath = resolve(outDir, file.outputPath);

    mkdirSync(dirname(outputPath), {recursive: true});
    writeFileSync(outputPath, file.outputText);

    if (file.sourceMapPath && file.sourceMapText) {
      const sourceMapPath = resolve(outDir, file.sourceMapPath);

      mkdirSync(dirname(sourceMapPath), {recursive: true});
      writeFileSync(sourceMapPath, file.sourceMapText);
    }
  }

  return result;
}

/** Formats graph diagnostics against their original source files. */
export function formatGraphDiagnostics(diagnostics: Diagnostic[]): string[] {
  return formatGraphDiagnosticsWithReader(diagnostics, (path) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined
  );
}

function nodeSourceHost(currentDirectory: string): GraphSourceHost {
  return {
    currentDirectory,
    fileExists: (path) => existsSync(nodePath(currentDirectory, path)),
    isFile: (path) => {
      const resolved = nodePath(currentDirectory, path);

      return existsSync(resolved) && statSync(resolved).isFile();
    },
    readDirectory: (path) => readFilesUnder(nodePath(currentDirectory, path)),
    readFile: (path) => {
      const resolved = nodePath(currentDirectory, path);

      return existsSync(resolved) ? readFileSync(resolved, "utf8") : undefined;
    },
  };
}

function readFilesUnder(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [];
  }

  return readdirSync(root, {withFileTypes: true}).flatMap((entry) => {
    const path = resolve(root, entry.name);

    return entry.isDirectory()
      ? readFilesUnder(path)
      : [normalizeNodePath(path)];
  });
}

function nodePath(currentDirectory: string, path: string): string {
  return resolvePath(currentDirectory, path);
}

function normalizeNodePath(path: string): string {
  return resolvePath(dirnamePath(path), path);
}

function resolvePath(currentDirectory: string, ...parts: string[]): string {
  let resolved = normalizePath(currentDirectory);

  for (const part of parts) {
    if (!part) {
      continue;
    }

    resolved = isAbsolutePath(part) ? normalizePath(part) : joinPath(resolved, part);
  }

  return resolved;
}
