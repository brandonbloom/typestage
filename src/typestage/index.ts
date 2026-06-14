/**
 * Public package surface for TypeStage.
 * Exports graph compilation APIs while keeping the runtime quote namespace
 * available to user source as `import {q} from "typestage"`.
 */
export {
  compileVirtualGraph,
  type CompileVirtualGraphOptions,
  type VirtualGraphFile,
} from "./graph.ts";
export {
  compileFileGraph,
  emitFileGraph,
  formatGraphDiagnostics,
  type CompileFileGraphOptions,
} from "./nodejs.ts";
export {
  compileRuntimeModule,
  type CompileRuntimeModuleOptions,
} from "./runtime-module.ts";
export {q, withOrigin, type RuntimeCode} from "./runtime.ts";
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
