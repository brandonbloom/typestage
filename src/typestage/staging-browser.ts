/**
 * Browser staging evaluator for static playground compilation.
 * It transpiles instrumented modules to CommonJS and runs them in a small
 * worker-local module loader.
 */
import * as ts from "typescript";
import {
  localModuleNotResolved,
  stagingEvaluationFailed,
} from "./diagnostics/index.ts";
import {
  __typestageCapturedHostValues,
  __typestageCapturedValues,
  __typestageResetCapturedValues,
  __typestageTag,
  capture,
  q,
} from "./runtime.ts";
import {errorMessage, stagingSource, type StagingEvaluator} from "./staging.ts";

type CommonJsModule = {
  exports: Record<string, unknown>;
  loaded: boolean;
};

export const evaluateBrowserStagingGraph: StagingEvaluator = async (
  entryPath,
  modules,
  resolveImport,
  hostCaptureNames = new Map(),
) => {
  const moduleSources = new Map<string, string>();
  const moduleRecords = new Map<string, CommonJsModule>();
  const moduleByPath = new Map(modules.map((module) => [module.inputPath, module]));

  for (const module of modules) {
    const sourceText = stagingSource(
      module.sourceFile,
      module.quotes,
      "typestage",
      hostCaptureNames,
      (specifier) => resolveImport(specifier, module.inputPath),
    );
    const output = ts.transpileModule(sourceText, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: module.inputPath,
    });

    moduleSources.set(module.inputPath, output.outputText);
  }

  const requireModule = (specifier: string, importerPath: string): Record<string, unknown> => {
    if (specifier === "typestage") {
      return {
        __typestageCapturedHostValues,
        __typestageCapturedValues,
        __typestageResetCapturedValues,
        __typestageTag,
        capture,
        q,
      };
    }

    const targetPath = moduleByPath.has(specifier)
      ? specifier
      : resolveImport(specifier, importerPath);

    if (!targetPath || !moduleByPath.has(targetPath)) {
      throw new Error(`staging import '${specifier}' could not be loaded from '${importerPath}'`);
    }

    return executeModule(targetPath).exports;
  };

  const executeModule = (path: string): CommonJsModule => {
    const existing = moduleRecords.get(path);

    if (existing?.loaded) {
      return existing;
    }

    const record = existing ?? {exports: {}, loaded: false};
    const sourceText = moduleSources.get(path);

    if (!sourceText) {
      throw new Error(`staging module '${path}' was not generated`);
    }

    moduleRecords.set(path, record);

    const moduleRequire = (specifier: string) => requireModule(specifier, path);
    const evaluator = new Function(
      "exports",
      "require",
      "module",
      `${sourceText}\n//# sourceURL=typestage-staging:${path}`,
    ) as (
      exports: Record<string, unknown>,
      require: (specifier: string) => Record<string, unknown>,
      module: CommonJsModule,
    ) => void;

    evaluator(record.exports, moduleRequire, record);
    record.loaded = true;

    return record;
  };

  if (!moduleByPath.has(entryPath)) {
    return {
      capturedValues: new Map(),
      capturedHostValues: new Map(),
      diagnostics: [
        {
          code: localModuleNotResolved.code,
          message: `entry module '${entryPath}' was not found in the staging graph`,
        },
      ],
    };
  }

  __typestageResetCapturedValues();

  try {
    executeModule(entryPath);
  } catch (error) {
    return {
      capturedValues: __typestageCapturedValues(),
      capturedHostValues: __typestageCapturedHostValues(),
      diagnostics: [
        {
          code: stagingEvaluationFailed.code,
          message: `staging evaluation failed: ${errorMessage(error)}`,
        },
      ],
    };
  }

  return {
    capturedValues: __typestageCapturedValues(),
    capturedHostValues: __typestageCapturedHostValues(),
    diagnostics: [],
  };
};
