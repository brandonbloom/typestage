/**
 * Runtime facade used by both user source and staging evaluation.
 * Quote tags return lightweight marker objects at runtime; the compiler
 * instruments those tags during staging so raw interpolation values can be
 * captured without exposing compiler internals as public API.
 */
import type {FragmentKind, QuoteCardinality} from "./types.ts";

/** Runtime placeholder returned by quote tags before compile-time expansion. */
export type RuntimeCode = {
  __typestageRuntimeCode: true;
  cardinality: QuoteCardinality;
  kind: FragmentKind;
  quoteId?: number;
  text: string;
  values: unknown[];
  hostValues?: Record<string, unknown>;
};

const capturedValues = new Map<number, unknown[]>();
const capturedHostValues = new Map<number, Record<string, unknown>>();

function code(
  kind: FragmentKind,
  cardinality: QuoteCardinality,
  strings: TemplateStringsArray,
  ...values: unknown[]
): RuntimeCode {
  let text = strings[0] ?? "";

  for (let i = 0; i < values.length; i++) {
    text += String(values[i]);
    text += strings[i + 1] ?? "";
  }

  return {
    __typestageRuntimeCode: true,
    cardinality,
    kind,
    text,
    values,
  };
}

/** Returns true when a runtime value is TypeStage quoted code. */
export function isRuntimeCode(value: unknown): value is RuntimeCode {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as RuntimeCode).__typestageRuntimeCode === true,
  );
}

/** Wraps a quote tag so staging evaluation records raw interpolation values. */
export function __typestageTag(
  quoteId: number,
  tag: (strings: TemplateStringsArray, ...values: unknown[]) => RuntimeCode,
  captureHostValues?: () => Record<string, unknown>,
) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const value = tag(strings, ...values);
    const hostValues = captureHostValues?.();

    value.quoteId = quoteId;
    value.hostValues = hostValues;
    capturedValues.set(quoteId, values);
    if (hostValues) {
      capturedHostValues.set(quoteId, hostValues);
    }

    return value;
  };
}

/** Clears interpolation values captured during staging evaluation. */
export function __typestageResetCapturedValues() {
  capturedValues.clear();
  capturedHostValues.clear();
}

/** Returns captured staging interpolation values keyed by static quote id. */
export function __typestageCapturedValues(): Map<number, unknown[]> {
  return new Map(capturedValues);
}

/** Returns captured staging host values keyed by static quote id. */
export function __typestageCapturedHostValues(): Map<number, Record<string, unknown>> {
  return new Map(capturedHostValues);
}

/** Placeholder for the future intentional-capture API. */
export function capture(name: string): () => string {
  return () => name;
}

/** Quote tag namespace recognized by the TypeStage compiler. */
export const q = {
  expr: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("expr", "one", strings, ...values),
  exprs: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("expr", "many", strings, ...values),
  ident: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("ident", "one", strings, ...values),
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
  stmts: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("stmt", "many", strings, ...values),
  block: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("block", "one", strings, ...values),
  decl: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("decl", "one", strings, ...values),
  decls: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("decl", "many", strings, ...values),
};
