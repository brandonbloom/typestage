/**
 * Node.js-backed staging evaluator for filesystem compilation.
 * It mirrors graph modules into a temp tree and imports the instrumented entry.
 */
import {mkdir, mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join} from "node:path";
import {pathToFileURL} from "node:url";
import {
  localModuleNotResolved,
  stagingEvaluationFailed,
} from "./diagnostics/index.ts";
import {
  __typestageCapturedHostValues,
  __typestageCapturedValues,
  __typestageResetCapturedValues,
} from "./runtime.ts";
import {
  errorMessage,
  stagingSource,
  type StagingEvaluator,
} from "./staging.ts";

export const evaluateNodeStagingGraph: StagingEvaluator = async (
  entryPath,
  modules,
  resolveImport,
  hostCaptureNames = new Map(),
) => {
  const runtimeUrl = new URL("./runtime.ts", import.meta.url).href;
  const directory = await mkdtemp(join(tmpdir(), "typestage-"));
  const tempPaths = new Map<string, string>();

  for (const module of modules) {
    const tempPath = join(directory, module.relativePath);

    tempPaths.set(module.inputPath, tempPath);
    await mkdir(dirname(tempPath), {recursive: true});
  }

  for (const module of modules) {
    const tempPath = tempPaths.get(module.inputPath)!;
    const sourceText = stagingSource(
      module.sourceFile,
      module.quotes,
      runtimeUrl,
      hostCaptureNames,
      (specifier) => {
        const targetPath = resolveImport(specifier, module.inputPath);
        const targetTempPath = targetPath ? tempPaths.get(targetPath) : undefined;

        return targetTempPath ? pathToFileURL(targetTempPath).href : undefined;
      },
    );

    await writeFile(tempPath, sourceText);
  }

  const entryTempPath = tempPaths.get(entryPath);

  if (!entryTempPath) {
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
    await import(`${pathToFileURL(entryTempPath).href}?t=${Date.now()}`);
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
