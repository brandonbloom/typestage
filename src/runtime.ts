import type {FragmentKind} from "./types.ts";

/** Runtime placeholder returned by quote tags before compile-time expansion. */
export type RuntimeCode = {
  kind: FragmentKind;
  text: string;
};

function code(kind: FragmentKind, strings: TemplateStringsArray, ...values: unknown[]) {
  let text = strings[0] ?? "";

  for (let i = 0; i < values.length; i++) {
    text += String(values[i]);
    text += strings[i + 1] ?? "";
  }

  return {kind, text};
}

/** Quote tag namespace recognized by the TypeStage compiler. */
export const q = {
  expr: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("expr", strings, ...values),
  stmt: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("stmt", strings, ...values),
  block: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("block", strings, ...values),
  decl: (strings: TemplateStringsArray, ...values: unknown[]) =>
    code("decl", strings, ...values),
};
