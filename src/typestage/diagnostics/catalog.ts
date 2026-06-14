/**
 * Central registry for TypeStage-owned diagnostic codes.
 * Parser diagnostics still use TypeScript's native `TS...` codes; this file
 * catalogs only `TSG...` diagnostics emitted by TypeStage itself.
 */

/** Metadata for one TypeStage diagnostic code. */
export type DiagnosticInfo = {
  code: `TSG${number}`;
  summary: string;
};

/** Explicit splice does not resolve to TypeStage code. */
export const unresolvedExplicitSplice = {
  code: "TSG1001",
  summary: "Explicit splice does not resolve to TypeStage code.",
} as const satisfies DiagnosticInfo;

/** Splice value is incompatible with the expected syntax position. */
export const incompatibleSplice = {
  code: "TSG1002",
  summary: "Splice value is incompatible with the expected syntax position.",
} as const satisfies DiagnosticInfo;

/** Block fragment cannot be adapted to expression position. */
export const blockExpressionAdapterFailed = {
  code: "TSG1003",
  summary: "Block fragment cannot be adapted to expression position.",
} as const satisfies DiagnosticInfo;

/** Recursive implicit unquote was detected. */
export const recursiveImplicitUnquote = {
  code: "TSG1004",
  summary: "Recursive implicit unquote was detected.",
} as const satisfies DiagnosticInfo;

/** Persistent runtime value cannot be serialized. */
export const persistentValueUnsupported = {
  code: "TSG1005",
  summary: "Persistent runtime value cannot be serialized.",
} as const satisfies DiagnosticInfo;

/** Staging evaluation failed. */
export const stagingEvaluationFailed = {
  code: "TSG1006",
  summary: "Staging evaluation failed.",
} as const satisfies DiagnosticInfo;

/** Local module could not be resolved. */
export const localModuleNotResolved = {
  code: "TSG1007",
  summary: "Local module could not be resolved.",
} as const satisfies DiagnosticInfo;

/** Local module does not export an imported name. */
export const localExportMissing = {
  code: "TSG1008",
  summary: "Local module does not export an imported name.",
} as const satisfies DiagnosticInfo;

/** Canonical catalog of TypeStage diagnostic metadata by code. */
export const diagnosticCatalog = {
  [unresolvedExplicitSplice.code]: unresolvedExplicitSplice,
  [incompatibleSplice.code]: incompatibleSplice,
  [blockExpressionAdapterFailed.code]: blockExpressionAdapterFailed,
  [recursiveImplicitUnquote.code]: recursiveImplicitUnquote,
  [persistentValueUnsupported.code]: persistentValueUnsupported,
  [stagingEvaluationFailed.code]: stagingEvaluationFailed,
  [localModuleNotResolved.code]: localModuleNotResolved,
  [localExportMissing.code]: localExportMissing,
} as const satisfies Record<string, DiagnosticInfo>;
