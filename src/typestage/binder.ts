/**
 * Syntactic binding summaries for parsed residual fragments.
 * The expander uses this to distinguish quoted-local names from host
 * code-valued bindings; it is intentionally syntactic, not a TypeScript
 * typechecker or full JavaScript scope model.
 */
import {collectBindingsInNode} from "./residual-scope.ts";
import type {CodeValue, ParsedFragment} from "./types.ts";

/** Snapshot-friendly summary of code-valued and residual bindings. */
export type BindingSummary = {
  codeBindings: Array<{
    name: string;
    kind: CodeValue["kind"];
    quoteId: number;
  }>;
  localBindingsByQuote: Array<{
    quoteId: number;
    names: string[];
  }>;
};

/** Builds host bindings known to contain TypeStage code values. */
export function buildCodeBindings(
  fragments: ParsedFragment[],
): Map<string, CodeValue> {
  const bindings = new Map<string, CodeValue>();

  for (const fragment of fragments) {
    const name = fragment.quote.bindingName;

    if (!name) {
      continue;
    }

    bindings.set(name, {
      cardinality: fragment.quote.cardinality,
      kind: fragment.quote.kind,
      quote: fragment.quote,
      parsed: fragment,
    });
  }

  return bindings;
}

/** Collects syntactic names declared inside a parsed residual fragment. */
export function collectLocalBindings(fragment: ParsedFragment): Set<string> {
  const names = new Set<string>();

  for (const node of fragment.nodes) {
    collectBindingsInNode(node, names);
  }

  return names;
}

/** Produces a stable binding summary for diagnostics and fixture output. */
export function summarizeBindings(
  fragments: ParsedFragment[],
  codeBindings: Map<string, CodeValue>,
): BindingSummary {
  return {
    codeBindings: Array.from(codeBindings.entries())
      .map(([name, value]) => ({
        name,
        kind: value.kind,
        quoteId: value.quote.id,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    localBindingsByQuote: fragments.map((fragment) => ({
      quoteId: fragment.quote.id,
      names: Array.from(collectLocalBindings(fragment)).sort(),
    })),
  };
}
