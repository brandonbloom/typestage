import {q} from "typestage";

// IDEA: Design binding-position list escapes inspired by Terra parameter and
// identifier-list escapes. A future API should splice generated bindings into
// parameter lists while preserving each binding's identity and hygiene.
const a = q.identifier("a", q.type`number`);
const b = q.identifier("b", q.type`number`);
const params = q.bindings([a, b]);

export const decl = q.decl`
  export function sum(${params}) {
    return ${a} + ${b};
  }
`;
