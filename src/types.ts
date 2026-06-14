import type * as ts from "typescript";

/** Supported TypeScript grammar entry points for TypeStage fragments. */
export type FragmentKind =
  | "expr"
  | "ident"
  | "type"
  | "pattern"
  | "stmt"
  | "block"
  | "decl";

/** Whether a quote parses one syntax node or a comma-separated syntax list. */
export type QuoteCardinality = "one" | "many";

/** Half-open range in an original source file. */
export type Origin = {
  sourceFile: string;
  start: number;
  end: number;
};

/** Per-character origin metadata for generated or virtual source text. */
export type OriginMap = Array<Origin | undefined>;

/** Compiler diagnostic with an optional mapped source origin. */
export type Diagnostic = {
  code: string;
  message: string;
  origin?: Origin;
};

/** Literal template text and the source origin of each character. */
export type TemplatePart = {
  text: string;
  originMap: OriginMap;
};

/** Explicit template interpolation represented as a parser placeholder. */
export type SpliceHole = {
  index: number;
  placeholder: string;
  expression: ts.Expression;
  origin: Origin;
};

/** A recognized TypeStage tagged-template quote in host source. */
export type QuoteForm = {
  id: number;
  kind: FragmentKind;
  cardinality: QuoteCardinality;
  node: ts.TaggedTemplateExpression;
  template: ts.TemplateLiteral;
  origin: Origin;
  parts: TemplatePart[];
  holes: SpliceHole[];
  bindingName?: string;
  exported: boolean;
};

/** Parsed virtual TypeScript representation of a quoted fragment. */
export type ParsedFragment = {
  quote: QuoteForm;
  source: string;
  originMap: OriginMap;
  virtualSource: string;
  virtualFileName: string;
  fragmentStart: number;
  sourceFile: ts.SourceFile;
  nodes: ts.Node[];
};

/** Compile-time representation of quoted code plus lexical metadata. */
export type CodeValue = {
  kind: FragmentKind;
  cardinality: QuoteCardinality;
  quote: QuoteForm;
  parsed: ParsedFragment;
  expandedNodes?: ts.Node[];
};

/** Public result returned by a TypeStage compile operation. */
export type CompileResult = {
  diagnostics: Diagnostic[];
  outputText: string;
  quotes: QuoteForm[];
};
