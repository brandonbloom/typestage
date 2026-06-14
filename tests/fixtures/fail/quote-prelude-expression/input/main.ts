import {q} from "typestage";

// IDEA: Design a first-class expression quote with a statement prelude,
// inspired by Terra's `quote ... in expr end`. This should generate setup
// statements and yield an expression without relying on the block adapter's
// IIFE fallback.
const value = q.exprWithPrelude`
  const temporary = compute();
in
  temporary * temporary
`;

export const decl = q.decl`
  export const squared = ${value};
`;
