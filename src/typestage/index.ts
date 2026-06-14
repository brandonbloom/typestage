/**
 * Public package surface for TypeStage.
 * Exports graph compilation APIs while keeping the runtime quote namespace
 * available to user source as `import {q} from "typestage"`.
 */
export {
  compileFileGraph,
  emitFileGraph,
  formatGraphDiagnostics,
  type CompileFileGraphOptions,
} from "./graph.ts";
export {q, type RuntimeCode} from "./runtime.ts";
export {originalPositionForGeneratedLocation} from "./source-map.ts";
export type {
  CodeValue,
  CompileGraphFile,
  CompileGraphPipeline,
  CompileGraphResult,
  Diagnostic,
  FragmentKind,
  Origin,
  ParsedFragment,
  QuoteForm,
  ResidualImport,
} from "./types.ts";
