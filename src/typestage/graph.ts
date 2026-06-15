/**
 * File graph compiler for TypeStage modules.
 * This layer resolves local relative imports, instruments every local module
 * for staging evaluation, makes code bindings visible across imports and
 * re-exports, then emits one residual file per source module.
 */
import * as ts from "typescript";
import {printStatements} from "./ast-print.ts";
import {
  localModuleNotResolved,
} from "./diagnostics/index.ts";
import {
  bindCompileUnits,
  collectCompileUnitHostCaptures,
  compileUnitPipelineSnapshot,
  expandCompileUnits,
  exportedStatementNames,
  parseDiagnosticsForCompileUnits,
  relativeCompileUnitInputPath,
  type CompileUnitImport,
  type CompileUnitModule,
  type CompileUnitReexport,
  validateCompileUnitLocalImports,
} from "./compile-unit.ts";
import {moduleStatementsForValue} from "./emitter.ts";
import {parseFragments} from "./fragments.ts";
import {formatOrigin} from "./origin.ts";
import {
  basename as basenamePath,
  dirname as dirnamePath,
  extname as extnamePath,
  isAbsolute as isAbsolutePath,
  join as joinPath,
  normalize as normalizePath,
  relative as relativePath,
} from "pathe";
import {extractQuotes, parseHostSource} from "./quote-extractor.ts";
import {referenceIdentifiers} from "./residual-scope.ts";
import {createSemanticContext, type SemanticContext, type SemanticHost} from "./semantic.ts";
import {createSourceMappedOutput, type SourceMapBlock} from "./source-map.ts";
import {evaluateBrowserStagingGraph} from "./staging-browser.ts";
import type {StagingEvaluator} from "./staging.ts";
import type {
  CodeValue,
  CompileGraphFile,
  CompileGraphResult,
  Diagnostic,
  ResidualImport,
} from "./types.ts";

/** Options for compiling a TypeStage module graph. */
export type CompileFileGraphOptions = {
  sourceMaps?: boolean;
  sourceRoot?: string;
};

/** Source file supplied to browser/static graph compilation. */
export type VirtualGraphFile = {
  fileName: string;
  source: string;
};

/** Options for compiling a virtual TypeStage module graph. */
export type CompileVirtualGraphOptions = {
  compilerOptions?: ts.CompilerOptions;
  sourceMaps?: boolean;
  sourceRoot?: string;
  stagingEvaluator?: StagingEvaluator;
};

/** Host used by the graph compiler core. */
export type GraphSourceHost = SemanticHost & {
  isFile(path: string): boolean;
};

export type CompileGraphOptions = {
  compilerOptions?: ts.CompilerOptions;
  currentDirectory: string;
  semanticHost?: SemanticHost;
  sourceMaps?: boolean;
  sourceRoot: string;
  stagingEvaluator: StagingEvaluator;
};

type GraphModule = CompileUnitModule;
type LocalImport = CompileUnitImport;
type LocalReexport = CompileUnitReexport;

type GeneratedStatementGroup = {
  origin: CodeValue["quote"]["origin"];
  residualImports: ResidualImport[];
  statements: ts.Statement[];
};

type GraphOutputPlan = {
  capturedImportStatements: ts.ImportDeclaration[];
  exportStatements: ts.ExportDeclaration[];
  generatedGroups: GeneratedStatementGroup[];
  importStatements: ts.ImportDeclaration[];
  module: GraphModule;
  sourceStatements: ts.Statement[];
};

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

/** Compiles a TypeStage module graph from an in-memory file set. */
export async function compileVirtualGraph(
  files: readonly VirtualGraphFile[],
  entryFileName: string,
  options: CompileVirtualGraphOptions = {},
): Promise<CompileGraphResult> {
  const sourceRoot = normalizeCompilerPath(options.sourceRoot ?? "/playground");
  const currentDirectory = dirnamePath(sourceRoot);
  const sourceFiles = new Map(files.map((file) => [
    resolvePath(sourceRoot, file.fileName),
    file.source,
  ]));
  const host = virtualSourceHost(currentDirectory, sourceFiles);

  return compileGraph(resolvePath(sourceRoot, entryFileName), host, {
    compilerOptions: options.compilerOptions,
    currentDirectory,
    semanticHost: host,
    sourceMaps: options.sourceMaps,
    sourceRoot,
    stagingEvaluator: options.stagingEvaluator ?? evaluateBrowserStagingGraph,
  });
}

/** Compiles a TypeStage entry file through the supplied source host. */
export async function compileGraph(
  entryPath: string,
  host: GraphSourceHost,
  options: CompileGraphOptions,
): Promise<CompileGraphResult> {
  const sourceRoot = normalizeCompilerPath(options.sourceRoot);
  const builder = new GraphBuilder(sourceRoot, host, options.currentDirectory);
  const entryAbsolutePath = resolvePath(options.currentDirectory, entryPath);
  let modules = builder.load(entryAbsolutePath);
  const semantic = createSemanticContext(
    entryAbsolutePath,
    modules.map((module) => module.inputPath),
    sourceRoot,
    options.semanticHost,
    options.compilerOptions,
  );

  modules = builder.rebindSourceFiles(semantic);

  const graphDiagnostics = builder.diagnostics;

  assignGraphQuoteIds(modules);

  const {
    exportedBindings,
    localCodeBindingsByModule,
    localValues,
    visibleBindingsByModule,
  } = bindCompileUnits(modules);
  const parseDiagnostics = parseDiagnosticsForCompileUnits(modules);
  const hostCaptures = parseDiagnostics.length === 0
    ? collectCompileUnitHostCaptures(modules, visibleBindingsByModule, semantic)
    : {diagnostics: [], hostCaptureNames: new Map<number, Set<string>>()};
  const earlyDiagnostics = [
    ...graphDiagnostics,
    ...validateCompileUnitLocalImports(modules),
    ...parseDiagnostics,
    ...hostCaptures.diagnostics,
  ];

  if (earlyDiagnostics.length > 0) {
    return {
      diagnostics: earlyDiagnostics,
      files: [],
      pipeline: compileUnitPipelineSnapshot({
        diagnostics: earlyDiagnostics,
        files: [],
        inputPath: relativeCompileUnitInputPath(options.currentDirectory),
        modules,
        values: localValues,
        visibleBindingsByModule,
      }),
    };
  }

  const staging = await options.stagingEvaluator(
    entryAbsolutePath,
    modules.map((module) => ({
      inputPath: module.inputPath,
      relativePath: module.outputPath,
      sourceFile: module.sourceFile,
      quotes: module.quotes,
    })),
    (specifier, importerPath) => builder.resolveLocalSpecifier(specifier, importerPath),
    hostCaptures.hostCaptureNames,
  );
  const expanded = expandCompileUnits(
    modules,
    visibleBindingsByModule,
    staging.capturedValues,
    staging.capturedHostValues,
    semantic,
  );
  const diagnostics = [
    ...graphDiagnostics,
    ...parseDiagnostics,
    ...staging.diagnostics,
    ...expanded.diagnostics,
  ];
  const files = diagnostics.length === 0
    ? emitGraphFiles(modules, expanded.values, {
        currentDirectory: options.currentDirectory,
        exportedBindings,
        host,
        localCodeBindingsByModule,
        sourceMaps: options.sourceMaps,
      })
    : [];

  return {
    diagnostics,
    files,
    pipeline: compileUnitPipelineSnapshot({
      diagnostics,
      files,
      inputPath: relativeCompileUnitInputPath(options.currentDirectory),
      modules,
      values: expanded.values,
      visibleBindingsByModule,
    }),
  };
}

class GraphBuilder {
  readonly diagnostics: Diagnostic[] = [];
  private readonly currentDirectory: string;
  private readonly host: GraphSourceHost;
  private readonly sourceRoot: string;
  private readonly modules = new Map<string, GraphModule>();

  constructor(sourceRoot: string, host: GraphSourceHost, currentDirectory: string) {
    this.currentDirectory = currentDirectory;
    this.host = host;
    this.sourceRoot = sourceRoot;
  }

  load(entryPath: string): GraphModule[] {
    this.loadModule(entryPath);

    return Array.from(this.modules.values())
      .sort((left, right) => left.outputPath.localeCompare(right.outputPath));
  }

  rebindSourceFiles(semantic: SemanticContext): GraphModule[] {
    for (const module of this.modules.values()) {
      const sourceFile = semantic.sourceFilesByPath.get(module.inputPath);

      if (!sourceFile) {
        continue;
      }

      const quotes = extractQuotes(sourceFile);

      normalizeQuoteOrigins(quotes, relativePath(this.currentDirectory, module.inputPath));
      const parsed = parseFragments(quotes);
      this.modules.set(
        module.inputPath,
        {
          inputPath: module.inputPath,
          outputPath: module.outputPath,
          sourceText: sourceFile.getFullText(),
          sourceFile,
          quotes,
          fragments: parsed.fragments,
          parseDiagnostics: parsed.diagnostics,
          imports: module.imports,
          residualImports: module.residualImports,
          reexports: module.reexports,
        },
      );
    }

    return Array.from(this.modules.values())
      .sort((left, right) => left.outputPath.localeCompare(right.outputPath));
  }

  resolveLocalSpecifier(specifier: string, importerPath: string): string | undefined {
    if (!isRelativeSpecifier(specifier)) {
      return undefined;
    }

    return resolveModulePath(
      resolvePath(this.currentDirectory, dirnamePath(importerPath), specifier),
      this.host,
    );
  }

  private loadModule(inputPath: string): GraphModule | undefined {
    const canonicalPath = resolvePath(this.currentDirectory, inputPath);
    const existing = this.modules.get(canonicalPath);

    if (existing) {
      return existing;
    }

    if (!this.host.fileExists(canonicalPath)) {
      this.diagnostics.push({
        code: localModuleNotResolved.code,
        message: `local module '${relativePath(this.currentDirectory, canonicalPath)}' could not be resolved`,
      });
      return undefined;
    }

    const sourceText = this.host.readFile(canonicalPath) ?? "";
    const outputPath = normalizeCompilerPath(relativePath(this.sourceRoot, canonicalPath));
    const sourceFile = parseHostSource(
      sourceText,
      relativePath(this.currentDirectory, canonicalPath),
    );
    const quotes = extractQuotes(sourceFile);
    const parsed = parseFragments(quotes);
    const module: GraphModule = {
      inputPath: canonicalPath,
      outputPath,
      sourceText,
      sourceFile,
      quotes,
      fragments: parsed.fragments,
      parseDiagnostics: parsed.diagnostics,
      imports: [],
      residualImports: new Map(),
      reexports: [],
    };

    this.modules.set(canonicalPath, module);

    for (const statement of sourceFile.statements) {
      this.collectEdges(module, statement);
    }

    return module;
  }

  private collectEdges(module: GraphModule, statement: ts.Statement) {
    if (ts.isImportDeclaration(statement)) {
      if (
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const targetPath = isRelativeSpecifier(statement.moduleSpecifier.text)
          ? this.resolveLocalSpecifier(statement.moduleSpecifier.text, module.inputPath)
          : undefined;

        for (const residualImport of residualNamedImports(
          statement,
          module,
          targetPath,
          this.sourceRoot,
        )) {
          module.residualImports.set(residualImport.local, residualImport);
        }
      }
    }

    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      isRelativeSpecifier(statement.moduleSpecifier.text)
    ) {
      const targetPath = this.resolveLocalSpecifier(
        statement.moduleSpecifier.text,
        module.inputPath,
      );

      if (!targetPath) {
        this.diagnostics.push({
          code: localModuleNotResolved.code,
          message: `local module '${statement.moduleSpecifier.text}' could not be resolved from '${module.sourceFile.fileName}'`,
          origin: {
            sourceFile: module.sourceFile.fileName,
            start: statement.moduleSpecifier.getStart(module.sourceFile),
            end: statement.moduleSpecifier.getEnd(),
          },
        });
        return;
      }

      this.loadModule(targetPath);

      if (ts.isImportDeclaration(statement)) {
        module.imports.push(...namedImports(statement, targetPath, module.sourceFile));
      } else {
        module.reexports.push(...namedReexports(statement, targetPath));
      }
    } else if (ts.isExportDeclaration(statement)) {
      module.reexports.push(...namedReexports(statement));
    }
  }
}

function normalizeQuoteOrigins(
  quotes: ReturnType<typeof extractQuotes>,
  sourceFileName: string,
) {
  for (const quote of quotes) {
    quote.origin = {...quote.origin, sourceFile: sourceFileName};

    if (quote.bindingNameOrigin) {
      quote.bindingNameOrigin = {
        ...quote.bindingNameOrigin,
        sourceFile: sourceFileName,
      };
    }

    for (const part of quote.parts) {
      part.originMap = part.originMap.map((origin) =>
        origin ? {...origin, sourceFile: sourceFileName} : origin
      );
    }

    for (const hole of quote.holes) {
      hole.origin = {...hole.origin, sourceFile: sourceFileName};
    }
  }
}

function assignGraphQuoteIds(modules: GraphModule[]) {
  let nextId = 0;

  for (const module of modules) {
    for (const quote of module.quotes) {
      quote.id = nextId;
      quote.moduleId = module.outputPath;
      nextId++;
    }
  }
}

function emitGraphFiles(
  modules: GraphModule[],
  values: Map<number, CodeValue>,
  options: {
    currentDirectory: string;
    exportedBindings: Map<string, Map<string, CodeValue>>;
    host: GraphSourceHost;
    localCodeBindingsByModule: Map<string, Map<string, CodeValue>>;
    sourceMaps?: boolean;
  },
): CompileGraphFile[] {
  const plans = planGraphOutput(modules, values, {
    exportedBindings: options.exportedBindings,
    localCodeBindingsByModule: options.localCodeBindingsByModule,
  });

  return plans.map((plan) => emitGraphOutputPlan(plan, modules, options));
}

function planGraphOutput(
  modules: GraphModule[],
  values: Map<number, CodeValue>,
  options: {
    exportedBindings: Map<string, Map<string, CodeValue>>;
    localCodeBindingsByModule: Map<string, Map<string, CodeValue>>;
  },
): GraphOutputPlan[] {
  const generatedGroupsByPath = new Map<string, GeneratedStatementGroup[]>();
  const generatedStatementsByPath = new Map<string, ts.Statement[]>();

  for (const module of modules) {
    const exportedValues = new Set(options.exportedBindings.get(module.inputPath)?.values() ?? []);
    const generatedGroups = Array.from(exportedValues)
      .filter((value) => value.quote.moduleId === module.outputPath)
      .map((value) => values.get(value.quote.id) ?? value)
      .map((value) => ({
        origin: value.quote.origin,
        residualImports: value.residualImports ?? [],
        statements: moduleStatementsForValue(value),
      }))
      .filter((group) => group.statements.length > 0);
    const generatedStatements = generatedGroups.flatMap((group) => group.statements);

    generatedGroupsByPath.set(module.inputPath, generatedGroups);
    generatedStatementsByPath.set(module.inputPath, generatedStatements);
  }

  const residualDemandByPath = collectResidualSourceDemands(
    modules,
    generatedGroupsByPath,
    options.localCodeBindingsByModule,
  );

  return modules.map((module) => {
    const generatedGroups = generatedGroupsByPath.get(module.inputPath) ?? [];
    const generatedStatements = generatedStatementsByPath.get(module.inputPath) ?? [];
    const sourceStatements = residualSourceStatements(
      module,
      residualDemandByPath.get(module.inputPath),
      options.localCodeBindingsByModule,
    );
    const usedIdentifiers = referenceIdentifiers([
      ...sourceStatements,
      ...generatedStatements,
    ]);
    const importStatements = module.sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => filteredImportDeclaration(statement, usedIdentifiers))
      .filter((statement): statement is ts.ImportDeclaration => Boolean(statement));
    const capturedImportStatements = movedResidualImportDeclarations(
      module,
      generatedGroups,
    );
    const exportStatements = module.sourceFile.statements
      .filter(ts.isExportDeclaration)
      .map(clonedExportDeclaration);

    return {
      capturedImportStatements,
      exportStatements,
      generatedGroups,
      importStatements,
      module,
      sourceStatements,
    };
  });
}

function emitGraphOutputPlan(
  plan: GraphOutputPlan,
  modules: GraphModule[],
  options: {
    currentDirectory: string;
    host: GraphSourceHost;
    sourceMaps?: boolean;
  },
): CompileGraphFile {
  const headerStatements = [
    ...plan.importStatements,
    ...plan.capturedImportStatements,
    ...plan.exportStatements,
  ];
  const blocks: SourceMapBlock[] = [
    {
      statements: headerStatements,
      text: printStatements(headerStatements),
    },
    {
      sourceFile: plan.module.sourceFile,
      statements: plan.sourceStatements,
      text: options.sourceMaps
        ? printOriginalSourceStatements(plan.sourceStatements, plan.module.sourceFile)
        : printSourceStatements(plan.sourceStatements, plan.module.sourceFile),
    },
    ...plan.generatedGroups.map((group) => ({
      origin: group.origin,
      statements: group.statements,
      text: printStatements(group.statements),
    })),
  ];
  const sourceMapped = createSourceMappedOutput(
    plan.module.outputPath,
    blocks,
    (sourceFile) => sourceTextForFile(
      sourceFile,
      modules,
      options.host,
      options.currentDirectory,
    ),
    {
      sourceFileName: (sourceFile) =>
        sourceMapSourceFileName(sourceFile, options.currentDirectory),
    },
  );
  const sourceMapPath = `${plan.module.outputPath}.map`;
  const outputText = options.sourceMaps
    ? `${sourceMapped.outputText}//# sourceMappingURL=${basenamePath(sourceMapPath)}\n`
    : sourceMapped.outputText;

  return {
    inputPath: relativePath(options.currentDirectory, plan.module.inputPath),
    outputPath: plan.module.outputPath,
    sourceMapPath: options.sourceMaps ? sourceMapPath : undefined,
    sourceMapText: options.sourceMaps ? sourceMapped.sourceMapText : undefined,
    outputText,
  };
}

function sourceTextForFile(
  sourceFile: string,
  modules: GraphModule[],
  host: GraphSourceHost,
  currentDirectory: string,
): string {
  const resolved = resolvePath(currentDirectory, sourceFile);
  const module = modules.find((candidate) =>
    candidate.sourceFile.fileName === sourceFile ||
    candidate.inputPath === resolved ||
    relativePath(currentDirectory, candidate.inputPath) === sourceFile
  );

  return module?.sourceText ?? host.readFile(resolved) ?? "";
}

function sourceMapSourceFileName(sourceFile: string, currentDirectory: string): string {
  if (!isAbsolutePath(sourceFile)) {
    return normalizePath(sourceFile);
  }

  const relativeSourceFile = relativePath(currentDirectory, sourceFile);

  return relativeSourceFile.startsWith("..") || relativeSourceFile === ""
    ? normalizePath(sourceFile)
    : normalizePath(relativeSourceFile);
}

function collectResidualSourceDemands(
  modules: GraphModule[],
  generatedGroupsByPath: Map<string, GeneratedStatementGroup[]>,
  localCodeBindingsByModule: Map<string, Map<string, CodeValue>>,
): Map<string, Set<string>> {
  const demandByPath = new Map<string, Set<string>>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const module of modules) {
      const sourceStatements = residualSourceStatements(
        module,
        demandByPath.get(module.inputPath),
        localCodeBindingsByModule,
      );
      const usedIdentifiers = referenceIdentifiers([
        ...sourceStatements,
        ...(generatedGroupsByPath.get(module.inputPath) ?? [])
          .flatMap((group) => group.statements),
      ]);

      for (const imported of module.imports) {
        if (!usedIdentifiers.has(imported.local)) {
          continue;
        }

        const demandedNames = demandByPath.get(imported.targetPath) ?? new Set<string>();
        const previousSize = demandedNames.size;

        demandedNames.add(imported.imported);
        demandByPath.set(imported.targetPath, demandedNames);

        if (demandedNames.size !== previousSize) {
          changed = true;
        }
      }

      for (const residualImport of (generatedGroupsByPath.get(module.inputPath) ?? [])
        .flatMap((group) => group.residualImports)) {
        if (!residualImport.targetInputPath) {
          continue;
        }

        const demandedNames = demandByPath.get(residualImport.targetInputPath) ??
          new Set<string>();
        const previousSize = demandedNames.size;

        demandedNames.add(residualImport.imported);
        demandByPath.set(residualImport.targetInputPath, demandedNames);

        if (demandedNames.size !== previousSize) {
          changed = true;
        }
      }
    }
  }

  return demandByPath;
}

function residualSourceStatements(
  module: GraphModule,
  demandedNames: Set<string> | undefined,
  localCodeBindingsByModule: Map<string, Map<string, CodeValue>>,
): ts.Statement[] {
  if (!demandedNames || demandedNames.size === 0) {
    return [];
  }

  const localCodeBindings = localCodeBindingsByModule.get(module.inputPath) ??
    new Map();

  return module.sourceFile.statements.filter((statement) =>
    exportedStatementNames(statement).some((name) =>
      demandedNames.has(name) && !localCodeBindings.has(name)
    )
  );
}

function resolveModulePath(basePath: string, host: GraphSourceHost): string | undefined {
  const candidates = extnamePath(basePath)
    ? [basePath]
    : [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.mts`,
        `${basePath}.cts`,
        joinPath(basePath, "index.ts"),
      ];

  return candidates.find((candidate) => host.fileExists(candidate) && host.isFile(candidate));
}

function namedImports(
  statement: ts.ImportDeclaration,
  targetPath: string,
  sourceFile: ts.SourceFile,
): LocalImport[] {
  const namedBindings = statement.importClause?.namedBindings;

  if (!namedBindings || !ts.isNamedImports(namedBindings)) {
    return [];
  }

  return namedBindings.elements.map((specifier) => ({
    imported: specifier.propertyName?.text ?? specifier.name.text,
    local: specifier.name.text,
    targetPath,
    origin: {
      sourceFile: sourceFile.fileName,
      start: specifier.getStart(sourceFile),
      end: specifier.getEnd(),
    },
  }));
}

function residualNamedImports(
  statement: ts.ImportDeclaration,
  module: GraphModule,
  targetPath: string | undefined,
  sourceRoot: string,
): ResidualImport[] {
  if (
    !statement.moduleSpecifier ||
    !ts.isStringLiteral(statement.moduleSpecifier) ||
    statement.moduleSpecifier.text === "typestage"
  ) {
    return [];
  }

  const moduleSpecifier = statement.moduleSpecifier.text;
  const namedBindings = statement.importClause?.namedBindings;

  if (!namedBindings || !ts.isNamedImports(namedBindings)) {
    return [];
  }

  return namedBindings.elements.map((specifier) => ({
    imported: specifier.propertyName?.text ?? specifier.name.text,
    local: specifier.name.text,
    moduleId: module.outputPath,
    specifier: moduleSpecifier,
    isTypeOnly: Boolean(statement.importClause?.isTypeOnly || specifier.isTypeOnly),
    targetInputPath: targetPath,
    targetOutputPath: targetPath ? normalizeCompilerPath(relativePath(sourceRoot, targetPath)) : undefined,
  }));
}

function namedReexports(
  statement: ts.ExportDeclaration,
  targetPath?: string,
): LocalReexport[] {
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return [];
  }

  return statement.exportClause.elements.map((specifier) => ({
    exported: specifier.name.text,
    imported: specifier.propertyName?.text ?? specifier.name.text,
    local: targetPath ? undefined : specifier.propertyName?.text ?? specifier.name.text,
    targetPath,
  }));
}

function filteredImportDeclaration(
  statement: ts.ImportDeclaration,
  usedIdentifiers: Set<string>,
): ts.ImportDeclaration | undefined {
  if (!ts.isStringLiteral(statement.moduleSpecifier)) {
    return statement;
  }

  if (statement.moduleSpecifier.text === "typestage") {
    return undefined;
  }

  const clause = statement.importClause;

  if (!clause) {
    return ts.factory.updateImportDeclaration(
      statement,
      ts.getModifiers(statement),
      undefined,
      ts.factory.createStringLiteral(statement.moduleSpecifier.text),
      statement.attributes,
    );
  }

  const defaultName = clause.name && usedIdentifiers.has(clause.name.text)
    ? clause.name
    : undefined;
  const namedBindings = filteredNamedBindings(clause.namedBindings, usedIdentifiers);

  if (!defaultName && !namedBindings) {
    return undefined;
  }

  return ts.factory.updateImportDeclaration(
    statement,
    ts.getModifiers(statement),
    ts.factory.updateImportClause(
      clause,
      clause.isTypeOnly,
      defaultName,
      namedBindings,
    ),
    ts.factory.createStringLiteral(statement.moduleSpecifier.text),
    statement.attributes,
  );
}

function movedResidualImportDeclarations(
  module: GraphModule,
  generatedGroups: GeneratedStatementGroup[],
): ts.ImportDeclaration[] {
  const importsBySpecifier = new Map<string, ResidualImport[]>();

  for (const residualImport of generatedGroups.flatMap((group) => group.residualImports)) {
    if (residualImport.moduleId === module.outputPath) {
      continue;
    }

    const specifier = residualImportSpecifier(module.outputPath, residualImport);
    const imports = importsBySpecifier.get(specifier) ?? [];

    if (!imports.some((existing) =>
      existing.imported === residualImport.imported &&
      existing.local === residualImport.local &&
      existing.isTypeOnly === residualImport.isTypeOnly
    )) {
      imports.push(residualImport);
    }

    importsBySpecifier.set(specifier, imports);
  }

  return Array.from(importsBySpecifier.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([specifier, imports]) => {
      const isTypeOnly = imports.every((residualImport) => residualImport.isTypeOnly);
      const elements = imports
        .sort((left, right) => left.local.localeCompare(right.local))
        .map((residualImport) =>
          ts.factory.createImportSpecifier(
            !isTypeOnly && residualImport.isTypeOnly,
            residualImport.imported === residualImport.local
              ? undefined
              : ts.factory.createIdentifier(residualImport.imported),
            ts.factory.createIdentifier(residualImport.local),
          )
        );

      return ts.factory.createImportDeclaration(
        undefined,
        ts.factory.createImportClause(
          isTypeOnly,
          undefined,
          ts.factory.createNamedImports(elements),
        ),
        ts.factory.createStringLiteral(specifier),
      );
    });
}

function residualImportSpecifier(
  importerOutputPath: string,
  residualImport: ResidualImport,
): string {
  if (!residualImport.targetOutputPath) {
    return residualImport.specifier;
  }

  const relativeImportPath = normalizeCompilerPath(relativePath(
    dirnamePath(importerOutputPath),
    stripTypeScriptExtension(residualImport.targetOutputPath),
  ));

  return relativeImportPath.startsWith(".") ? relativeImportPath : `./${relativeImportPath}`;
}

function clonedExportDeclaration(statement: ts.ExportDeclaration): ts.ExportDeclaration {
  return ts.factory.updateExportDeclaration(
    statement,
    ts.getModifiers(statement),
    statement.isTypeOnly,
    statement.exportClause,
    statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? ts.factory.createStringLiteral(statement.moduleSpecifier.text)
      : statement.moduleSpecifier,
    statement.attributes,
  );
}

function filteredNamedBindings(
  bindings: ts.NamedImportBindings | undefined,
  usedIdentifiers: Set<string>,
): ts.NamedImportBindings | undefined {
  if (!bindings) {
    return undefined;
  }

  if (ts.isNamespaceImport(bindings)) {
    return usedIdentifiers.has(bindings.name.text) ? bindings : undefined;
  }

  const elements = bindings.elements.filter((specifier) =>
    usedIdentifiers.has(specifier.name.text)
  );

  return elements.length > 0
    ? ts.factory.updateNamedImports(bindings, elements)
    : undefined;
}

function printSourceStatements(
  statements: ts.Statement[],
  sourceFile: ts.SourceFile,
): string {
  if (statements.length === 0) {
    return "";
  }

  return `${statements.map((statement) =>
    printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile).trimEnd()
  ).join("\n")}\n`;
}

function printOriginalSourceStatements(
  statements: ts.Statement[],
  sourceFile: ts.SourceFile,
): string {
  if (statements.length === 0) {
    return "";
  }

  return `${statements.map((statement) =>
    sourceFile.text.slice(statement.getStart(sourceFile), statement.end).trimEnd()
  ).join("\n")}\n`;
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function normalizeCompilerPath(path: string): string {
  return normalizePath(path);
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

function stripTypeScriptExtension(path: string): string {
  return path.replace(/\.(?:cts|mts|tsx?|jsx?)$/, "");
}

function virtualSourceHost(
  currentDirectory: string,
  sourceFiles: Map<string, string>,
): GraphSourceHost {
  const declarationFiles = new Map([
    [resolvePath(currentDirectory, "lib.d.ts"), ambientDeclarations()],
  ]);
  const allFiles = new Map([...declarationFiles, ...sourceFiles]);

  return {
    currentDirectory,
    fileExists: (path) => allFiles.has(resolvePath(currentDirectory, path)),
    isFile: (path) => allFiles.has(resolvePath(currentDirectory, path)),
    readDirectory: (path) => {
      const root = resolvePath(currentDirectory, path);

      return Array.from(allFiles.keys()).filter((fileName) =>
        fileName.startsWith(root === "/" ? "/" : `${root}/`)
      );
    },
    readFile: (path) => allFiles.get(resolvePath(currentDirectory, path)),
  };
}

function ambientDeclarations(): string {
  return `
declare const console: { log(...values: unknown[]): void; error(...values: unknown[]): void; warn(...values: unknown[]): void };
declare const Infinity: number;
declare const NaN: number;
declare const Symbol: { for(key: string): symbol; keyFor(symbol: symbol): string | undefined; (description?: string): symbol };
declare const JSON: { stringify(value: unknown): string; parse(text: string): unknown };
declare class Date { constructor(value?: string | number); toISOString(): string; }
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

/** Formats graph diagnostics against their original source files. */
export function formatGraphDiagnostics(
  diagnostics: Diagnostic[],
  readFile: (path: string) => string | undefined = () => undefined,
): string[] {
  const sourceCache = new Map<string, string>();

  return diagnostics.map((diagnostic) => {
    if (!diagnostic.origin) {
      return `${diagnostic.code}: ${diagnostic.message}`;
    }

    let sourceText = sourceCache.get(diagnostic.origin.sourceFile);

    if (sourceText === undefined) {
      sourceText = readFile(diagnostic.origin.sourceFile) ?? "";
      sourceCache.set(diagnostic.origin.sourceFile, sourceText);
    }

    return `${formatOrigin(sourceText, diagnostic.origin)} - ${diagnostic.code}: ${diagnostic.message}`;
  });
}
