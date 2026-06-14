/**
 * File graph compiler for TypeStage modules.
 * This layer resolves local relative imports, instruments every local module
 * for staging evaluation, makes code bindings visible across imports and
 * re-exports, then emits one residual file per source module.
 */
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {basename, dirname, extname, join, relative, resolve, sep} from "node:path";
import * as ts from "typescript";
import {buildCodeBindings, summarizeBindings} from "./binder.ts";
import {
  localExportMissing,
  localModuleNotResolved,
} from "./diagnostics/index.ts";
import {moduleStatementsForValue, printCodeValue} from "./emitter.ts";
import {collectHostCaptureNames, expandFragments} from "./expander.ts";
import {parseFragments} from "./fragments.ts";
import {formatOrigin} from "./origin.ts";
import {extractQuotes, parseHostSource} from "./quote-extractor.ts";
import {createSemanticContext, type SemanticContext} from "./semantic.ts";
import {createSourceMappedOutput, type SourceMapBlock} from "./source-map.ts";
import {evaluateStagingGraph} from "./staging.ts";
import type {
  CodeValue,
  CompileGraphFile,
  CompileGraphPipeline,
  CompileGraphResult,
  Diagnostic,
  ParsedFragment,
  ResidualImport,
} from "./types.ts";

/** Options for compiling a TypeStage module graph. */
export type CompileFileGraphOptions = {
  sourceMaps?: boolean;
  sourceRoot?: string;
};

type GraphModule = {
  inputPath: string;
  outputPath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
  quotes: ReturnType<typeof extractQuotes>;
  fragments: ParsedFragment[];
  parseDiagnostics: Diagnostic[];
  localCodeBindings: Map<string, CodeValue>;
  imports: LocalImport[];
  residualImports: Map<string, ResidualImport>;
  reexports: LocalReexport[];
};

type LocalImport = {
  imported: string;
  local: string;
  targetPath: string;
  origin: Diagnostic["origin"];
};

type LocalReexport = {
  exported: string;
  imported: string;
  targetPath?: string;
  local?: string;
};

type GeneratedStatementGroup = {
  origin: CodeValue["quote"]["origin"];
  residualImports: ResidualImport[];
  statements: ts.Statement[];
};

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

/** Compiles a TypeStage entry file and its local module graph. */
export async function compileFileGraph(
  entryPath: string,
  options: CompileFileGraphOptions = {},
): Promise<CompileGraphResult> {
  const sourceRoot = resolve(options.sourceRoot ?? dirname(resolve(entryPath)));
  const builder = new GraphBuilder(sourceRoot);
  const entryAbsolutePath = resolve(entryPath);
  let modules = builder.load(entryAbsolutePath);
  const semantic = createSemanticContext(
    entryAbsolutePath,
    modules.map((module) => module.inputPath),
    sourceRoot,
  );

  modules = builder.rebindSourceFiles(semantic);

  const graphDiagnostics = builder.diagnostics;

  assignGraphQuoteIds(modules);

  const fragments = modules.flatMap((module) => module.fragments);
  const localValues = new Map<number, CodeValue>();

  for (const module of modules) {
    module.localCodeBindings = buildCodeBindings(module.fragments);

    for (const value of module.localCodeBindings.values()) {
      localValues.set(value.quote.id, value);
    }
  }

  const exportedBindings = buildExportBindings(modules);
  const visibleBindingsByModule = buildVisibleBindings(modules, exportedBindings);
  const parseDiagnostics = modules.flatMap((module) => module.parseDiagnostics);
  const hostCaptures = parseDiagnostics.length === 0
    ? collectHostCaptureNames(
        fragments,
        (fragment) => visibleBindingsByModule.get(fragment.quote.moduleId ?? "") ?? new Map(),
        semantic,
        (fragment) => residualImportsForModule(modules, fragment.quote.moduleId),
      )
    : {diagnostics: [], hostCaptureNames: new Map<number, Set<string>>()};
  const earlyDiagnostics = [
    ...graphDiagnostics,
    ...validateLocalImports(modules),
    ...parseDiagnostics,
    ...hostCaptures.diagnostics,
  ];

  if (earlyDiagnostics.length > 0) {
    return {
      diagnostics: earlyDiagnostics,
      files: [],
      pipeline: graphPipelineSnapshot(
        modules,
        visibleBindingsByModule,
        localValues,
        earlyDiagnostics,
        [],
      ),
    };
  }

  const staging = await evaluateStagingGraph(
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
  const expanded = expandFragments(
    fragments,
    (fragment) => visibleBindingsByModule.get(fragment.quote.moduleId ?? "") ?? new Map(),
    staging.capturedValues,
    staging.capturedHostValues,
    semantic,
    (fragment) => residualImportsForModule(modules, fragment.quote.moduleId),
  );
  const diagnostics = [
    ...graphDiagnostics,
    ...parseDiagnostics,
    ...staging.diagnostics,
    ...expanded.diagnostics,
  ];
  const files = diagnostics.length === 0
    ? emitGraphFiles(modules, expanded.values, exportedBindings, options)
    : [];

  return {
    diagnostics,
    files,
    pipeline: graphPipelineSnapshot(
      modules,
      visibleBindingsByModule,
      expanded.values,
      diagnostics,
      files,
    ),
  };
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
    const outputPath = join(outDir, file.outputPath);

    mkdirSync(dirname(outputPath), {recursive: true});
    writeFileSync(outputPath, file.outputText);

    if (file.sourceMapPath && file.sourceMapText) {
      const sourceMapPath = join(outDir, file.sourceMapPath);

      mkdirSync(dirname(sourceMapPath), {recursive: true});
      writeFileSync(sourceMapPath, file.sourceMapText);
    }
  }

  return result;
}

class GraphBuilder {
  readonly diagnostics: Diagnostic[] = [];
  private readonly sourceRoot: string;
  private readonly modules = new Map<string, GraphModule>();

  constructor(sourceRoot: string) {
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

      normalizeQuoteOrigins(quotes, relative(process.cwd(), module.inputPath));
      const parsed = parseFragments(quotes);
      module.sourceText = sourceFile.getFullText();
      module.sourceFile = sourceFile;
      module.quotes = quotes;
      module.fragments = parsed.fragments;
      module.parseDiagnostics = parsed.diagnostics;
      module.localCodeBindings = new Map();
    }

    return Array.from(this.modules.values())
      .sort((left, right) => left.outputPath.localeCompare(right.outputPath));
  }

  resolveLocalSpecifier(specifier: string, importerPath: string): string | undefined {
    if (!isRelativeSpecifier(specifier)) {
      return undefined;
    }

    return resolveModulePath(resolve(dirname(importerPath), specifier));
  }

  private loadModule(inputPath: string): GraphModule | undefined {
    const canonicalPath = resolve(inputPath);
    const existing = this.modules.get(canonicalPath);

    if (existing) {
      return existing;
    }

    if (!existsSync(canonicalPath)) {
      this.diagnostics.push({
        code: localModuleNotResolved.code,
        message: `local module '${relative(process.cwd(), canonicalPath)}' could not be resolved`,
      });
      return undefined;
    }

    const sourceText = readFileSync(canonicalPath, "utf8");
    const outputPath = normalizePath(relative(this.sourceRoot, canonicalPath));
    const sourceFile = parseHostSource(sourceText, relative(process.cwd(), canonicalPath));
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
      localCodeBindings: new Map(),
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

function buildExportBindings(modules: GraphModule[]): Map<string, Map<string, CodeValue>> {
  const byPath = new Map(modules.map((module) => [module.inputPath, module]));
  const cache = new Map<string, Map<string, CodeValue>>();

  const exportsFor = (module: GraphModule): Map<string, CodeValue> => {
    const cached = cache.get(module.inputPath);

    if (cached) {
      return cached;
    }

    const exported = new Map<string, CodeValue>();

    cache.set(module.inputPath, exported);

    for (const value of module.localCodeBindings.values()) {
      if (value.quote.exported && value.quote.bindingName) {
        exported.set(value.quote.bindingName, value);
      }
    }

    for (const reexport of module.reexports) {
      if (reexport.local) {
        const value = module.localCodeBindings.get(reexport.local);

        if (value) {
          exported.set(reexport.exported, value);
        }
      } else if (reexport.targetPath) {
        const target = byPath.get(reexport.targetPath);
        const value = target ? exportsFor(target).get(reexport.imported) : undefined;

        if (value) {
          exported.set(reexport.exported, value);
        }
      }
    }

    return exported;
  };

  return new Map(modules.map((module) => [module.inputPath, exportsFor(module)]));
}

function buildVisibleBindings(
  modules: GraphModule[],
  exportedBindings: Map<string, Map<string, CodeValue>>,
): Map<string, Map<string, CodeValue>> {
  const visible = new Map<string, Map<string, CodeValue>>();

  for (const module of modules) {
    const bindings = new Map(module.localCodeBindings);

    for (const imported of module.imports) {
      const value = exportedBindings.get(imported.targetPath)?.get(imported.imported);

      if (value) {
        bindings.set(imported.local, value);
      }
    }

    visible.set(module.outputPath, bindings);
  }

  return visible;
}

function residualImportsForModule(
  modules: GraphModule[],
  moduleId: string | undefined,
): Map<string, ResidualImport> {
  return modules.find((module) => module.outputPath === moduleId)?.residualImports ??
    new Map();
}

function validateLocalImports(modules: GraphModule[]): Diagnostic[] {
  const byPath = new Map(modules.map((module) => [module.inputPath, module]));
  const exportNamesByPath = new Map(
    modules.map((module) => [module.inputPath, sourceExportNames(module)]),
  );
  const diagnostics: Diagnostic[] = [];

  for (const module of modules) {
    for (const imported of module.imports) {
      const target = byPath.get(imported.targetPath);

      if (!target) {
        continue;
      }

      if (!exportNamesByPath.get(target.inputPath)?.has(imported.imported)) {
        diagnostics.push({
          code: localExportMissing.code,
          message: `local module '${target.outputPath}' does not export '${imported.imported}'`,
          origin: imported.origin,
        });
      }
    }
  }

  return diagnostics;
}

function emitGraphFiles(
  modules: GraphModule[],
  values: Map<number, CodeValue>,
  exportedBindings: Map<string, Map<string, CodeValue>>,
  options: CompileFileGraphOptions,
): CompileGraphFile[] {
  const generatedGroupsByPath = new Map<string, GeneratedStatementGroup[]>();
  const generatedStatementsByPath = new Map<string, ts.Statement[]>();

  for (const module of modules) {
    const exportedValues = new Set(exportedBindings.get(module.inputPath)?.values() ?? []);
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
  );

  return modules.map((module) => {
    const generatedGroups = generatedGroupsByPath.get(module.inputPath) ?? [];
    const generatedStatements = generatedStatementsByPath.get(module.inputPath) ?? [];
    const sourceStatements = residualSourceStatements(
      module,
      residualDemandByPath.get(module.inputPath),
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
    const blocks: SourceMapBlock[] = [
      {
        statements: [
          ...importStatements,
          ...capturedImportStatements,
          ...exportStatements,
        ],
        text: printStatements([
          ...importStatements,
          ...capturedImportStatements,
          ...exportStatements,
        ]),
      },
      {
        sourceFile: module.sourceFile,
        statements: sourceStatements,
        text: options.sourceMaps
          ? printOriginalSourceStatements(sourceStatements, module.sourceFile)
          : printSourceStatements(sourceStatements, module.sourceFile),
      },
      ...generatedGroups.map((group) => ({
        origin: group.origin,
        statements: group.statements,
        text: printStatements(group.statements),
      })),
    ];
    const sourceMapped = createSourceMappedOutput(
      module.outputPath,
      blocks,
      (sourceFile) => sourceTextForFile(sourceFile, modules),
    );
    const sourceMapPath = `${module.outputPath}.map`;
    const outputText = options.sourceMaps
      ? `${sourceMapped.outputText}//# sourceMappingURL=${basename(sourceMapPath)}\n`
      : sourceMapped.outputText;

    return {
      inputPath: relative(process.cwd(), module.inputPath),
      outputPath: module.outputPath,
      sourceMapPath: options.sourceMaps ? sourceMapPath : undefined,
      sourceMapText: options.sourceMaps ? sourceMapped.sourceMapText : undefined,
      outputText,
    };
  });
}

function sourceTextForFile(sourceFile: string, modules: GraphModule[]): string {
  const module = modules.find((candidate) => candidate.sourceFile.fileName === sourceFile);

  return module?.sourceText ?? (existsSync(sourceFile) ? readFileSync(sourceFile, "utf8") : "");
}

function collectResidualSourceDemands(
  modules: GraphModule[],
  generatedGroupsByPath: Map<string, GeneratedStatementGroup[]>,
): Map<string, Set<string>> {
  const demandByPath = new Map<string, Set<string>>();
  let changed = true;

  while (changed) {
    changed = false;

    for (const module of modules) {
      const sourceStatements = residualSourceStatements(
        module,
        demandByPath.get(module.inputPath),
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
): ts.Statement[] {
  if (!demandedNames || demandedNames.size === 0) {
    return [];
  }

  return module.sourceFile.statements.filter((statement) =>
    exportedStatementNames(statement).some((name) =>
      demandedNames.has(name) && !module.localCodeBindings.has(name)
    )
  );
}

function graphPipelineSnapshot(
  modules: GraphModule[],
  visibleBindingsByModule: Map<string, Map<string, CodeValue>>,
  values: Map<number, CodeValue>,
  diagnostics: Diagnostic[],
  files: CompileGraphFile[],
): CompileGraphPipeline {
  return {
    modules: modules.map((module) => ({
      inputPath: relative(process.cwd(), module.inputPath),
      outputPath: module.outputPath,
      quotes: module.quotes.map((quote) => ({
        id: quote.id,
        moduleId: quote.moduleId,
        kind: quote.kind,
        bindingName: quote.bindingName,
        exported: quote.exported,
      })),
      bindings: summarizeBindings(module.fragments, visibleBindingsByModule.get(module.outputPath) ?? new Map()),
    })),
    expanded: Array.from(values.values()).map((value) => ({
      quoteId: value.quote.id,
      moduleId: value.quote.moduleId,
      kind: value.kind,
      text: printCodeValue(value),
    })),
    diagnostics,
    files: files.map((file) => ({
      inputPath: file.inputPath,
      outputPath: file.outputPath,
    })),
  };
}

function resolveModulePath(basePath: string): string | undefined {
  const candidates = extname(basePath)
    ? [basePath]
    : [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        `${basePath}.mts`,
        `${basePath}.cts`,
        join(basePath, "index.ts"),
      ];

  return candidates.find((candidate) =>
    existsSync(candidate) && statSync(candidate).isFile()
  );
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
    targetOutputPath: targetPath ? normalizePath(relative(sourceRoot, targetPath)) : undefined,
  }));
}

function sourceExportNames(module: GraphModule): Set<string> {
  const names = new Set<string>();

  for (const statement of module.sourceFile.statements) {
    for (const name of exportedStatementNames(statement)) {
      names.add(name);
    }
  }

  return names;
}

function exportedStatementNames(statement: ts.Statement): string[] {
  if (ts.isExportDeclaration(statement)) {
    return namedExportedNames(statement);
  }

  if (!hasExportModifier(statement)) {
    return [];
  }

  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  ) {
    return [statement.name.text];
  }

  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name)
    );
  }

  return [];
}

function namedExportedNames(statement: ts.ExportDeclaration): string[] {
  if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
    return [];
  }

  return statement.exportClause.elements.map((specifier) => specifier.name.text);
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  ));
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }

  return name.elements.flatMap((element) => {
    if (ts.isOmittedExpression(element) || !element.name) {
      return [];
    }

    return bindingNames(element.name);
  });
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

  const relativePath = normalizePath(relative(
    dirname(importerOutputPath),
    stripTypeScriptExtension(residualImport.targetOutputPath),
  ));

  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function stripTypeScriptExtension(path: string): string {
  return path.replace(/\.(?:cts|mts|tsx?|jsx?)$/, "");
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

function referenceIdentifiers(statements: ts.Statement[]): Set<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node, scopes: readonly Set<string>[]) => {
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      if (!scopes.some((scope) => scope.has(node.text))) {
        names.add(node.text);
      }
    }

    if (isFunctionLikeWithBody(node)) {
      const scope = new Set<string>();

      if (ts.isFunctionExpression(node) && node.name) {
        scope.add(node.name.text);
      }

      for (const parameter of node.parameters) {
        collectBindingNames(parameter.name, scope);
      }

      if (node.body) {
        visitNodeList([node.body], [...scopes, scope]);
      }
      return;
    }

    if (ts.isBlock(node)) {
      visitNodeList(Array.from(node.statements), scopes);
      return;
    }

    if (ts.isForStatement(node)) {
      const scope = new Set<string>();

      if (node.initializer && ts.isVariableDeclarationList(node.initializer)) {
        for (const declaration of node.initializer.declarations) {
          collectBindingNames(declaration.name, scope);
        }
      }

      ts.forEachChild(node, (child) => visit(child, [...scopes, scope]));
      return;
    }

    if (ts.isCatchClause(node)) {
      const scope = new Set<string>();

      if (node.variableDeclaration) {
        collectBindingNames(node.variableDeclaration.name, scope);
      }

      visit(node.block, [...scopes, scope]);
      return;
    }

    ts.forEachChild(node, (child) => visit(child, scopes));
  };

  const visitNodeList = (nodes: readonly ts.Node[], scopes: readonly Set<string>[]) => {
    const scope = new Set<string>();

    for (const node of nodes) {
      collectDirectBindingNames(node, scope);
    }

    const nextScopes = [...scopes, scope];

    for (const node of nodes) {
      visit(node, nextScopes);
    }
  };

  visitNodeList(statements, []);

  return names;
}

function collectDirectBindingNames(node: ts.Node, names: Set<string>) {
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
    return;
  }

  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    names.add(node.name.text);
    return;
  }

  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;

    if (clause?.name) {
      names.add(clause.name.text);
    }

    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      names.add(clause.namedBindings.name.text);
    } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const specifier of clause.namedBindings.elements) {
        names.add(specifier.name.text);
      }
    }
  }
}

function collectBindingNames(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element) && element.name) {
      collectBindingNames(element.name, names);
    }
  }
}

function isFunctionLikeWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)) &&
    Boolean(node.body)
  );
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (!parent) {
    return true;
  }

  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return false;
  }

  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return false;
  }

  if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent)) {
    return false;
  }

  if (ts.isParameter(parent) || ts.isFunctionDeclaration(parent)) {
    return false;
  }

  if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
    return false;
  }

  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) {
    return false;
  }

  return true;
}

function printStatements(statements: ts.Statement[]): string {
  if (statements.length === 0) {
    return "";
  }

  const sourceFile = ts.factory.createSourceFile(
    statements,
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );

  return `${printer.printFile(sourceFile).trimEnd()}\n`;
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

function normalizePath(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/** Formats graph diagnostics against their original source files. */
export function formatGraphDiagnostics(diagnostics: Diagnostic[]): string[] {
  const sourceCache = new Map<string, string>();

  return diagnostics.map((diagnostic) => {
    if (!diagnostic.origin) {
      return `${diagnostic.code}: ${diagnostic.message}`;
    }

    let sourceText = sourceCache.get(diagnostic.origin.sourceFile);

    if (sourceText === undefined) {
      sourceText = existsSync(diagnostic.origin.sourceFile)
        ? readFileSync(diagnostic.origin.sourceFile, "utf8")
        : "";
      sourceCache.set(diagnostic.origin.sourceFile, sourceText);
    }

    return `${formatOrigin(sourceText, diagnostic.origin)} - ${diagnostic.code}: ${diagnostic.message}`;
  });
}
