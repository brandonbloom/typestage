import * as ts from "typescript";
import {
  basename as basenamePath,
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

type SemanticEnvironment = {
  compilerHost?: ts.CompilerHost;
  compilerOptions: ts.CompilerOptions;
  currentDirectory: string;
  lookupPath?: string;
  rootNames: readonly string[];
  sourcePaths: readonly string[];
};

/** Builds a TypeScript program using tsconfig options plus graph source roots. */
export function createSemanticContext(
  entryPath: string,
  graphPaths: readonly string[],
  sourceRoot: string,
  host?: SemanticHost,
  compilerOptions?: ts.CompilerOptions,
): SemanticContext {
  const currentDirectory = host?.currentDirectory ??
    ts.sys?.getCurrentDirectory?.() ??
    "/";
  const parsed = host
    ? {...defaultConfig(), options: compilerOptions ?? defaultConfig().options}
    : parsedNodeConfig(entryPath);
  const sourcePaths = uniquePaths(graphPaths, currentDirectory);
  const rootNames = [
    ...parsed.fileNames,
    ...sourcePaths,
    ...declarationFilesUnder(sourceRoot, host),
  ];

  return createSemanticContextForEnvironment({
    compilerHost: host ? compilerHostForSemanticHost(host, parsed.options) : undefined,
    compilerOptions: parsed.options,
    currentDirectory,
    rootNames,
    sourcePaths,
  });
}

/** Builds a TypeScript program for runtime-created fragments. */
export function createRuntimeSemanticContext(
  sourceFileName: string,
  sourceText: string,
  sourceRoot = ts.sys?.getCurrentDirectory?.() ?? "/",
): SemanticContext {
  const currentDirectory = ts.sys?.getCurrentDirectory?.() ?? "/";
  const virtualPath = resolveSemanticPath(sourceFileName, currentDirectory);
  const parsed = parsedNodeConfig(virtualPath);
  const rootNames = [
    ...parsed.fileNames,
    virtualPath,
    ...declarationFilesUnder(sourceRoot),
  ];

  return createSemanticContextForEnvironment({
    compilerHost: overlayCompilerHost(
      parsed.options,
      currentDirectory,
      new Map([[virtualPath, sourceText]]),
    ),
    compilerOptions: parsed.options,
    currentDirectory,
    lookupPath: virtualPath,
    rootNames,
    sourcePaths: [virtualPath],
  });
}

function createSemanticContextForEnvironment(
  environment: SemanticEnvironment,
): SemanticContext {
  const rootNames = uniquePaths(
    environment.rootNames,
    environment.currentDirectory,
  );
  const sourcePaths = new Set(uniquePaths(
    environment.sourcePaths,
    environment.currentDirectory,
  ));
  const lookupPath = environment.lookupPath
    ? resolveSemanticPath(environment.lookupPath, environment.currentDirectory)
    : undefined;
  const program = ts.createProgram({
    host: environment.compilerHost,
    options: environment.compilerOptions,
    rootNames,
  });
  const sourceFilesByPath = new Map<string, ts.SourceFile>();

  for (const sourceFile of program.getSourceFiles()) {
    const fileName = resolveSemanticPath(
      sourceFile.fileName,
      environment.currentDirectory,
    );

    if (!sourceFile.isDeclarationFile || sourcePaths.has(fileName)) {
      sourceFilesByPath.set(fileName, sourceFile);
    }
  }

  const lookupSourceFile = lookupPath ? program.getSourceFile(lookupPath) : undefined;

  return {
    checker: program.getTypeChecker(),
    lookupNode: lookupSourceFile?.statements[0],
    program,
    sourceFilesByPath,
  };
}

function fallbackAmbientDeclarations(): string {
  return `
declare const console: { log(...values: unknown[]): void; error(...values: unknown[]): void; warn(...values: unknown[]): void };
declare const Infinity: number;
declare const NaN: number;
declare const Symbol: { for(key: string): symbol; keyFor(symbol: symbol): string | undefined; (description?: string): symbol };
declare const JSON: { stringify(value: unknown): string; parse(text: string): unknown };
declare class Date { constructor(value?: string | number); static now(): number; toISOString(): string; }
declare class Promise<T> { static resolve<T>(value: T): Promise<T>; }
declare class Map<K, V> { constructor(entries?: readonly (readonly [K, V])[]); }
declare class Set<T> { constructor(values?: readonly T[]); }
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

/** Returns true when a host value-space name has callable or constructable type. */
export function hostValueNameIsCallableOrConstructable(
  semantic: SemanticContext | undefined,
  fragment: ParsedFragment,
  name: string,
  excludeGlobals: boolean,
): boolean {
  const symbol = resolveHostValueName(semantic, fragment, name, excludeGlobals);

  if (!semantic || !symbol) {
    return false;
  }

  const type = semantic.checker.getTypeOfSymbolAtLocation(
    symbol,
    semantic.lookupNode ?? fragment.quote.node,
  );

  return type.getCallSignatures().length > 0 ||
    type.getConstructSignatures().length > 0;
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

function compilerHostForSemanticHost(
  host: SemanticHost,
  compilerOptions: ts.CompilerOptions,
): ts.CompilerHost {
  const sourceFiles = new Map<string, ts.SourceFile>();
  const defaultLibFileName = defaultLibFileNameForCompilerHost(compilerOptions);
  const readFileText = (fileName: string): string | undefined => {
    const resolved = resolveSemanticPath(fileName, host.currentDirectory);

    return host.readFile(resolved) ??
      readTypeScriptLibFile(fileName, compilerOptions) ??
      fallbackAmbientFile(fileName, defaultLibFileName);
  };
  const getSourceFile = (fileName: string, languageVersion: ts.ScriptTarget) => {
    const resolved = resolveSemanticPath(fileName, host.currentDirectory);
    const existing = sourceFiles.get(resolved) ?? host.getSourceFile?.(resolved);

    if (existing) {
      sourceFiles.set(resolved, existing);
      return existing;
    }

    const text = readFileText(fileName);

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
    fileExists: (fileName) =>
      host.fileExists(resolveSemanticPath(fileName, host.currentDirectory)) ||
      readTypeScriptLibFile(fileName, compilerOptions) !== undefined ||
      fallbackAmbientFile(fileName, defaultLibFileName) !== undefined,
    getCanonicalFileName: (fileName) =>
      host.useCaseSensitiveFileNames === false ? fileName.toLowerCase() : fileName,
    getCurrentDirectory: () => host.currentDirectory,
    getDefaultLibFileName: () => defaultLibFileName,
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile,
    readFile: readFileText,
    useCaseSensitiveFileNames: () => host.useCaseSensitiveFileNames ?? true,
    writeFile: () => {},
  };
}

function defaultLibFileNameForCompilerHost(
  compilerOptions: ts.CompilerOptions,
): string {
  if (ts.sys) {
    try {
      return normalizePath(ts.getDefaultLibFilePath(compilerOptions));
    } catch {
      // Fall through to TypeScript's portable lib file name.
    }
  }

  return ts.getDefaultLibFileName(compilerOptions);
}

function readTypeScriptLibFile(
  fileName: string,
  compilerOptions: ts.CompilerOptions,
): string | undefined {
  const sys = ts.sys;

  if (!sys) {
    return undefined;
  }

  if (sys.fileExists(fileName)) {
    return sys.readFile(fileName);
  }

  try {
    const libDirectory = dirnamePath(ts.getDefaultLibFilePath(compilerOptions));
    const candidate = joinPath(libDirectory, basenamePath(fileName));

    return sys.fileExists(candidate) ? sys.readFile(candidate) : undefined;
  } catch {
    return undefined;
  }
}

function fallbackAmbientFile(
  fileName: string,
  defaultLibFileName: string,
): string | undefined {
  return basenamePath(fileName) === basenamePath(defaultLibFileName)
    ? fallbackAmbientDeclarations()
    : undefined;
}

function overlayCompilerHost(
  compilerOptions: ts.CompilerOptions,
  currentDirectory: string,
  sourceFiles: Map<string, string>,
): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const parsedSourceFiles = new Map<string, ts.SourceFile>();

  host.fileExists = (fileName) => {
    const resolved = resolveSemanticPath(fileName, currentDirectory);

    return sourceFiles.has(resolved) || fileExists(fileName);
  };
  host.readFile = (fileName) => {
    const resolved = resolveSemanticPath(fileName, currentDirectory);

    return sourceFiles.get(resolved) ?? readFile(fileName);
  };
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile,
  ) => {
    const resolved = resolveSemanticPath(fileName, currentDirectory);
    const sourceText = sourceFiles.get(resolved);

    if (sourceText === undefined) {
      return getSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    }

    const existing = parsedSourceFiles.get(resolved);

    if (existing) {
      return existing;
    }

    const sourceFile = ts.createSourceFile(
      resolved,
      sourceText,
      languageVersion,
      true,
      fileKind(resolved),
    );

    parsedSourceFiles.set(resolved, sourceFile);

    return sourceFile;
  };

  return host;
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
