import * as ts from "typescript";
import {
  dirname as dirnamePath,
  isAbsolute as isAbsolutePath,
  join as joinPath,
  normalize as normalizePath,
} from "pathe";
import type {ParsedFragment} from "./types.ts";

/** TypeScript semantic lookup context for quote-site name resolution. */
export type SemanticContext = {
  checker: ts.TypeChecker;
  lookupNode?: ts.Node;
  program: ts.Program;
  sourceFilesByPath: Map<string, ts.SourceFile>;
};

/** Host used to build TypeScript semantic information without assuming Node. */
export type SemanticHost = {
  currentDirectory: string;
  fileExists(path: string): boolean;
  getSourceFile?(path: string): ts.SourceFile | undefined;
  readDirectory?(path: string): string[];
  readFile(path: string): string | undefined;
  useCaseSensitiveFileNames?: boolean;
};

/** Builds a TypeScript program using tsconfig options plus graph source roots. */
export function createSemanticContext(
  entryPath: string,
  graphPaths: readonly string[],
  sourceRoot: string,
  host?: SemanticHost,
  compilerOptions?: ts.CompilerOptions,
): SemanticContext {
  const parsed = host
    ? {...defaultConfig(), options: compilerOptions ?? defaultConfig().options}
    : parsedNodeConfig(entryPath);
  const rootNames = uniquePaths([
    ...parsed.fileNames,
    ...graphPaths,
    ...declarationFilesUnder(sourceRoot, host),
  ], host?.currentDirectory);
  const compilerHost = host
    ? virtualCompilerHost(host)
    : undefined;
  const program = ts.createProgram({
    rootNames,
    options: parsed.options,
    host: compilerHost,
  });
  const sourceFilesByPath = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = resolveSemanticPath(sourceFile.fileName, host?.currentDirectory);

    if (!sourceFile.isDeclarationFile || graphPaths.includes(fileName)) {
      sourceFilesByPath.set(fileName, sourceFile);
    }
  }

  return {
    checker: program.getTypeChecker(),
    program,
    sourceFilesByPath,
  };
}

/** Builds a TypeScript program for runtime-created fragments. */
export function createRuntimeSemanticContext(
  sourceFileName: string,
  sourceText: string,
  sourceRoot = ts.sys?.getCurrentDirectory?.() ?? "/",
): SemanticContext {
  const currentDirectory = ts.sys?.getCurrentDirectory?.() ?? "/";
  const virtualPath = resolveSemanticPath(sourceFileName, currentDirectory);
  const configPath = ts.sys
    ? ts.findConfigFile(dirnamePath(virtualPath), ts.sys.fileExists) ??
      ts.findConfigFile(currentDirectory, ts.sys.fileExists)
    : undefined;
  const parsed = configPath ? readTsConfig(configPath) : defaultConfig();
  const rootNames = uniquePaths([
    ...parsed.fileNames,
    virtualPath,
    ...declarationFilesUnder(sourceRoot),
  ], currentDirectory);
  const host = ts.createCompilerHost(parsed.options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);

  host.fileExists = (fileName) =>
    resolveSemanticPath(fileName, currentDirectory) === virtualPath || fileExists(fileName);
  host.readFile = (fileName) =>
    resolveSemanticPath(fileName, currentDirectory) === virtualPath ? sourceText : readFile(fileName);
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) =>
    resolveSemanticPath(fileName, currentDirectory) === virtualPath
      ? ts.createSourceFile(
          fileName,
          sourceText,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
      : getSourceFile(
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        );

  const program = ts.createProgram({
    host,
    rootNames,
    options: parsed.options,
  });
  const sourceFilesByPath = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = resolveSemanticPath(sourceFile.fileName, currentDirectory);

    if (!sourceFile.isDeclarationFile || fileName === virtualPath) {
      sourceFilesByPath.set(fileName, sourceFile);
    }
  }

  const virtualSourceFile = program.getSourceFile(virtualPath);

  return {
    checker: program.getTypeChecker(),
    lookupNode: virtualSourceFile?.statements[0],
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
    semantic.lookupNode ?? fragment.quote.node,
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
    semantic.lookupNode ?? fragment.quote.node,
    ts.SymbolFlags.Type,
    excludeGlobals,
  );
}

function parsedNodeConfig(entryPath: string): ts.ParsedCommandLine {
  const sys = ts.sys;
  const configPath = sys
    ? ts.findConfigFile(dirnamePath(entryPath), sys.fileExists) ??
      ts.findConfigFile(sys.getCurrentDirectory(), sys.fileExists)
    : undefined;

  return configPath ? readTsConfig(configPath) : defaultConfig();
}

function readTsConfig(configPath: string): ts.ParsedCommandLine {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);

  if (config.error) {
    return defaultConfig();
  }

  return ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirnamePath(configPath),
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

function declarationFilesUnder(root: string, host?: SemanticHost): string[] {
  if (host?.readDirectory) {
    return host.readDirectory(root).filter((path) => path.endsWith(".d.ts"));
  }

  return ts.sys?.readDirectory?.(root, [".d.ts"]) ?? [];
}

function uniquePaths(paths: readonly string[], currentDirectory = ts.sys?.getCurrentDirectory?.() ?? "/"): string[] {
  return Array.from(new Set(paths.map((path) => resolveSemanticPath(path, currentDirectory))));
}

function resolveSemanticPath(path: string, currentDirectory = ts.sys?.getCurrentDirectory?.() ?? "/"): string {
  return resolvePath(currentDirectory, path);
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

function virtualCompilerHost(host: SemanticHost): ts.CompilerHost {
  const sourceFiles = new Map<string, ts.SourceFile>();
  const getSourceFile = (fileName: string, languageVersion: ts.ScriptTarget) => {
    const resolved = resolveSemanticPath(fileName, host.currentDirectory);
    const existing = sourceFiles.get(resolved) ?? host.getSourceFile?.(resolved);

    if (existing) {
      sourceFiles.set(resolved, existing);
      return existing;
    }

    const text = host.readFile(resolved);

    if (text === undefined) {
      return undefined;
    }

    const sourceFile = ts.createSourceFile(
      resolved,
      text,
      languageVersion,
      true,
      fileKind(resolved),
    );

    sourceFiles.set(resolved, sourceFile);

    return sourceFile;
  };

  return {
    fileExists: (fileName) => host.fileExists(resolveSemanticPath(fileName, host.currentDirectory)),
    getCanonicalFileName: (fileName) =>
      host.useCaseSensitiveFileNames === false ? fileName.toLowerCase() : fileName,
    getCurrentDirectory: () => host.currentDirectory,
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile,
    readFile: (fileName) => host.readFile(resolveSemanticPath(fileName, host.currentDirectory)),
    useCaseSensitiveFileNames: () => host.useCaseSensitiveFileNames ?? true,
    writeFile: () => {},
  };
}

function fileKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (path.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }

  return ts.ScriptKind.TS;
}
