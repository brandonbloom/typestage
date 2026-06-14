/**
 * Public diagnostics module for TypeStage internals.
 * Re-export diagnostic metadata from the catalog so compiler components can
 * use named entries without depending on the catalog file layout.
 */

export {
  blockExpressionAdapterFailed,
  diagnosticCatalog,
  incompatibleSplice,
  localExportMissing,
  localModuleNotResolved,
  persistentValueUnsupported,
  recursiveImplicitUnquote,
  stagingEvaluationFailed,
  type DiagnosticInfo,
  unresolvedExplicitSplice,
  unresolvedResidualReference,
} from "./catalog.ts";
