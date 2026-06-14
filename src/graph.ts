/**
 * File graph compiler for TypeStage modules.
 * This layer resolves local relative imports, instruments every local module
 * for staging evaluation, makes code bindings visible across imports and
 * re-exports, then emits one residual file per source module.
 */
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {dirname, extname, join, relative, resolve, sep} from "node:path";
import * as ts from "typescript";
import {buildCodeBindings, summarizeBindings} from "./binder.ts";
import {moduleStatementsForValue, printCodeValue} from "./emitter.ts";
import {expandFragments} from "./expander.ts";
import {parseFragments} from "./fragments.ts";
import {formatOrigin} from "./origin.ts";
import {extractQuotes, parseHostSource} from "./quote-extractor.ts";
import {evaluateStagingGraph} from "./staging.ts";
import type {
  CodeValue,
  CompileGraphFile,
  CompileGraphPipeline,
  CompileGraphResult,
  Diagnostic,
  ParsedFragment,
} from "./types.ts";

/** Options for compiling a TypeStage module graph. */
export type CompileFileGraphOptions = {
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
  const modules = builder.load(entryAbsolutePath);
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
  const earlyDiagnostics = [
    ...graphDiagnostics,
    ...validateLocalImports(modules),
    ...modules.flatMap((module) => module.parseDiagnostics),
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
  );
  const expanded = expandFragments(
    fragments,
    (fragment) => visibleBindingsByModule.get(fragment.quote.moduleId ?? "") ?? new Map(),
    staging.capturedValues,
  );
  const diagnostics = [
    ...graphDiagnostics,
    ...modules.flatMap((module) => module.parseDiagnostics),
    ...staging.diagnostics,
    ...expanded.diagnostics,
  ];
  const files = diagnostics.length === 0
    ? emitGraphFiles(modules, expanded.values, exportedBindings)
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
        code: "TSG1007",
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
      reexports: [],
    };

    this.modules.set(canonicalPath, module);

    for (const statement of sourceFile.statements) {
      this.collectEdges(module, statement);
    }

    return module;
  }

  private collectEdges(module: GraphModule, statement: ts.Statement) {
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
          code: "TSG1007",
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
          code: "TSG1008",
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
): CompileGraphFile[] {
  const generatedStatementsByPath = new Map<string, ts.Statement[]>();

  for (const module of modules) {
    const exportedValues = new Set(exportedBindings.get(module.inputPath)?.values() ?? []);
    const generatedStatements = Array.from(exportedValues)
      .filter((value) => value.quote.moduleId === module.outputPath)
      .map((value) => values.get(value.quote.id) ?? value)
      .flatMap((value) => moduleStatementsForValue(value));

    generatedStatementsByPath.set(module.inputPath, generatedStatements);
  }

  const residualDemandByPath = collectResidualSourceDemands(
    modules,
    generatedStatementsByPath,
  );

  return modules.map((module) => {
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
    const exportStatements = module.sourceFile.statements
      .filter(ts.isExportDeclaration)
      .map(clonedExportDeclaration);
    const outputText = printStatementBlocks([
      printStatements([
        ...importStatements,
        ...exportStatements,
      ]),
      printSourceStatements(sourceStatements, module.sourceFile),
      printStatements(generatedStatements),
    ]);

    return {
      inputPath: relative(process.cwd(), module.inputPath),
      outputPath: module.outputPath,
      outputText,
    };
  });
}

function collectResidualSourceDemands(
  modules: GraphModule[],
  generatedStatementsByPath: Map<string, ts.Statement[]>,
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
        ...(generatedStatementsByPath.get(module.inputPath) ?? []),
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

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      names.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  for (const statement of statements) {
    visit(statement);
  }

  return names;
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

function printStatementBlocks(blocks: string[]): string {
  const text = blocks
    .map((block) => block.trimEnd())
    .filter((block) => block.length > 0)
    .join("\n");

  return text.length === 0 ? "" : `${text}\n`;
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
