import {existsSync, readdirSync, statSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import * as ts from "typescript";
import type {ParsedFragment} from "./types.ts";

/** TypeScript semantic lookup context for quote-site name resolution. */
export type SemanticContext = {
  checker: ts.TypeChecker;
  program: ts.Program;
  sourceFilesByPath: Map<string, ts.SourceFile>;
};

/** Builds a TypeScript program using tsconfig options plus graph source roots. */
export function createSemanticContext(
  entryPath: string,
  graphPaths: readonly string[],
  sourceRoot: string,
): SemanticContext {
  const configPath = ts.findConfigFile(dirname(entryPath), ts.sys.fileExists) ??
    ts.findConfigFile(process.cwd(), ts.sys.fileExists);
  const parsed = configPath ? readTsConfig(configPath) : defaultConfig();
  const rootNames = uniquePaths([
    ...parsed.fileNames,
    ...graphPaths,
    ...declarationFilesUnder(sourceRoot),
  ]);
  const program = ts.createProgram({
    rootNames,
    options: parsed.options,
  });
  const sourceFilesByPath = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile || graphPaths.includes(resolve(sourceFile.fileName))) {
      sourceFilesByPath.set(resolve(sourceFile.fileName), sourceFile);
    }
  }

  return {
    checker: program.getTypeChecker(),
    program,
    sourceFilesByPath,
  };
}

/** Resolves a value-space name at the host quote site. */
export function resolveHostValueName(
  semantic: SemanticContext | undefined,
  fragment: ParsedFragment,
  name: string,
  excludeGlobals: boolean,
): ts.Symbol | undefined {
  return semantic?.checker.resolveName(
    name,
    fragment.quote.node,
    ts.SymbolFlags.Value,
    excludeGlobals,
  );
}

/** Resolves a type-space name at the host quote site. */
export function resolveHostTypeName(
  semantic: SemanticContext | undefined,
  fragment: ParsedFragment,
  name: string,
  excludeGlobals: boolean,
): ts.Symbol | undefined {
  return semantic?.checker.resolveName(
    name,
    fragment.quote.node,
    ts.SymbolFlags.Type,
    excludeGlobals,
  );
}

function readTsConfig(configPath: string): ts.ParsedCommandLine {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);

  if (config.error) {
    return defaultConfig();
  }

  return ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
  );
}

function defaultConfig(): ts.ParsedCommandLine {
  return {
    errors: [],
    fileNames: [],
    options: {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.Preserve,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      target: ts.ScriptTarget.ES2024,
    },
    raw: {},
    typeAcquisition: {enable: false, exclude: [], include: []},
    wildcardDirectories: {},
  };
}

function declarationFilesUnder(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [];
  }

  return readdirSync(root, {withFileTypes: true}).flatMap((entry) => {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      return declarationFilesUnder(path);
    }

    return entry.isFile() && entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function uniquePaths(paths: readonly string[]): string[] {
  return Array.from(new Set(paths.map((path) => resolve(path))));
}
