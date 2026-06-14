import {q} from "typestage";

// IDEA: Design explicit identifier objects inspired by Terra's
// `symbol(type, displayName)`. The identifier should carry binding identity,
// optional type metadata, and a preferred display name without relying on text
// capture or accidental lexical lookup.
const x = q.identifier("x", q.type`number`);

export const decl = q.decl`
  export function read(${x}: number) {
    return ${x};
  }
`;
