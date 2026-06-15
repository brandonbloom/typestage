/**
 * Shared compile-unit graph model for TypeStage modules.
 * File graph and runtime compilation both lower their inputs to these units
 * before binding, expansion, diagnostics, and pipeline snapshots.
 */
import * as ts from "typescript";
import {buildCodeBindings, summarizeBindings} from "./binder.ts";
import {localExportMissing} from "./diagnostics/index.ts";
import {printCodeValue} from "./emitter.ts";
import {collectHostCaptureNames, expandFragments} from "./expander.ts";
import {relative as relativePath} from "pathe";
import {bindingNames} from "./residual-scope.ts";
import type {SemanticContext} from "./semantic.ts";
import type {
  CodeValue,
  CompileGraphFile,
  CompileGraphPipeline,
  Diagnostic,
  ParsedFragment,
  QuoteForm,
  ResidualImport,
} from "./types.ts";

export type CompileUnitModule = {
  inputPath: string;
  outputPath: string;
  sourceText: string;
  sourceFile: ts.SourceFile;
  quotes: QuoteForm[];
  fragments: ParsedFragment[];
  parseDiagnostics: Diagnostic[];
  imports: CompileUnitImport[];
  residualImports: Map<string, ResidualImport>;
  reexports: CompileUnitReexport[];
};

export type CompileUnitImport = {
  imported: string;
  local: string;
  targetPath: string;
  origin: Diagnostic["origin"];
};

export type CompileUnitReexport = {
  exported: string;
  imported: string;
  targetPath?: string;
  local?: string;
};

export type CompileUnitBindingState = {
  exportedBindings: Map<string, Map<string, CodeValue>>;
  localCodeBindingsByModule: Map<string, Map<string, CodeValue>>;
  localValues: Map<number, CodeValue>;
  visibleBindingsByModule: Map<string, Map<string, CodeValue>>;
};

export function bindCompileUnits(
  modules: CompileUnitModule[],
): CompileUnitBindingState {
  const localCodeBindingsByModule = new Map<string, Map<string, CodeValue>>();
  const localValues = new Map<number, CodeValue>();

  for (const module of modules) {
    const localCodeBindings = buildCodeBindings(module.fragments);

    localCodeBindingsByModule.set(module.inputPath, localCodeBindings);

    for (const value of localCodeBindings.values()) {
      localValues.set(value.quote.id, value);
    }
  }

  const exportedBindings = buildExportBindings(modules, localCodeBindingsByModule);
  const visibleBindingsByModule = buildVisibleBindings(
    modules,
    localCodeBindingsByModule,
    exportedBindings,
  );

  return {
    exportedBindings,
    localCodeBindingsByModule,
    localValues,
    visibleBindingsByModule,
  };
}

export function parseDiagnosticsForCompileUnits(
  modules: CompileUnitModule[],
): Diagnostic[] {
  return modules.flatMap((module) => module.parseDiagnostics);
}

function fragmentsForCompileUnits(
  modules: CompileUnitModule[],
): ParsedFragment[] {
  return modules.flatMap((module) => module.fragments);
}

export function collectCompileUnitHostCaptures(
  modules: CompileUnitModule[],
  visibleBindingsByModule: Map<string, Map<string, CodeValue>>,
  semantic?: SemanticContext,
) {
  return collectHostCaptureNames(
    fragmentsForCompileUnits(modules),
    (fragment) => visibleBindingsByModule.get(fragment.quote.moduleId ?? "") ?? new Map(),
    semantic,
    (fragment) => residualImportsForCompileUnitModule(modules, fragment.quote.moduleId),
  );
}

export function expandCompileUnits(
  modules: CompileUnitModule[],
  visibleBindingsByModule: Map<string, Map<string, CodeValue>>,
  capturedValues: Map<number, unknown[]> = new Map(),
  capturedHostValues: Map<number, Record<string, unknown>> = new Map(),
  semantic?: SemanticContext,
) {
  return expandFragments(
    fragmentsForCompileUnits(modules),
    (fragment) => visibleBindingsByModule.get(fragment.quote.moduleId ?? "") ?? new Map(),
    capturedValues,
    capturedHostValues,
    semantic,
    (fragment) => residualImportsForCompileUnitModule(modules, fragment.quote.moduleId),
  );
}

function residualImportsForCompileUnitModule(
  modules: CompileUnitModule[],
  moduleId: string | undefined,
): Map<string, ResidualImport> {
  return modules.find((module) => module.outputPath === moduleId)?.residualImports ??
    new Map();
}

export function validateCompileUnitLocalImports(
  modules: CompileUnitModule[],
): Diagnostic[] {
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

export function compileUnitPipelineSnapshot(options: {
  diagnostics: Diagnostic[];
  files: CompileGraphFile[];
  inputPath?: (module: CompileUnitModule) => string;
  modules: CompileUnitModule[];
  values: Map<number, CodeValue>;
  visibleBindingsByModule: Map<string, Map<string, CodeValue>>;
}): CompileGraphPipeline {
  return {
    modules: options.modules.map((module) => ({
      inputPath: options.inputPath?.(module) ?? module.inputPath,
      outputPath: module.outputPath,
      quotes: module.quotes.map((quote) => ({
        id: quote.id,
        moduleId: quote.moduleId,
        kind: quote.kind,
        bindingName: quote.bindingName,
        exported: quote.exported,
      })),
      bindings: summarizeBindings(
        module.fragments,
        options.visibleBindingsByModule.get(module.outputPath) ?? new Map(),
      ),
    })),
    expanded: Array.from(options.values.values()).map((value) => ({
      quoteId: value.quote.id,
      moduleId: value.quote.moduleId,
      kind: value.kind,
      text: printCodeValue(value),
    })),
    diagnostics: options.diagnostics,
    files: options.files.map((file) => ({
      inputPath: file.inputPath,
      outputPath: file.outputPath,
    })),
  };
}

export function relativeCompileUnitInputPath(currentDirectory: string) {
  return (module: CompileUnitModule) => relativePath(currentDirectory, module.inputPath);
}

function buildExportBindings(
  modules: CompileUnitModule[],
  localCodeBindingsByModule: Map<string, Map<string, CodeValue>>,
): Map<string, Map<string, CodeValue>> {
  const byPath = new Map(modules.map((module) => [module.inputPath, module]));
  const cache = new Map<string, Map<string, CodeValue>>();

  const exportsFor = (module: CompileUnitModule): Map<string, CodeValue> => {
    const cached = cache.get(module.inputPath);

    if (cached) {
      return cached;
    }

    const exported = new Map<string, CodeValue>();

    cache.set(module.inputPath, exported);

    const localCodeBindings = localCodeBindingsByModule.get(module.inputPath) ??
      new Map();

    for (const value of localCodeBindings.values()) {
      if (value.quote.exported && value.quote.bindingName) {
        exported.set(value.quote.bindingName, value);
      }
    }

    for (const reexport of module.reexports) {
      if (reexport.local) {
        const value = localCodeBindings.get(reexport.local);

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
  modules: CompileUnitModule[],
  localCodeBindingsByModule: Map<string, Map<string, CodeValue>>,
  exportedBindings: Map<string, Map<string, CodeValue>>,
): Map<string, Map<string, CodeValue>> {
  const visible = new Map<string, Map<string, CodeValue>>();

  for (const module of modules) {
    const bindings = new Map(localCodeBindingsByModule.get(module.inputPath));

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

function sourceExportNames(module: CompileUnitModule): Set<string> {
  const names = new Set<string>();

  for (const statement of module.sourceFile.statements) {
    for (const name of exportedStatementNames(statement)) {
      names.add(name);
    }
  }

  return names;
}

export function exportedStatementNames(statement: ts.Statement): string[] {
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
