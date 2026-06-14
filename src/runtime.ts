import type {FragmentKind, QuoteCardinality} from "./types.ts";

/** Runtime placeholder returned by quote tags before compile-time expansion. */
export type RuntimeCode = {
  cardinality: QuoteCardinality;
  kind: FragmentKind;
  text: string;
};

function code(
  kind: FragmentKind,
  cardinality: QuoteCardinality,
  strings: TemplateStringsArray,
  ...values: unknown[]
) {
  let text = strings[0] ?? "";

  for (let i = 0; i < values.length; i++) {
    text += String(values[i]);
    text += strings[i + 1] ?? "";
  }

  return {cardinality, kind, text};
}

/** Quote tag namespace recognized by the TypeStage compiler. */
export const q = {
  expr: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("expr", "one", strings, ...values),
  exprs: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("expr", "many", strings, ...values),
  type: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("type", "one", strings, ...values),
  types: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("type", "many", strings, ...values),
  pattern: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("pattern", "one", strings, ...values),
  patterns: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("pattern", "many", strings, ...values),
  stmt: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("stmt", "one", strings, ...values),
  block: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("block", "one", strings, ...values),
  decl: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("decl", "one", strings, ...values),
};
