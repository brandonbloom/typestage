import {q} from "typestage";

// IDEA: Design residual constants inspired by Terra constants. Large or shared
// persisted values could lower to a generated binding once, then splice
// references to that binding instead of duplicating inline literals.
const table = q.constant("TABLE", [1, 1, 2, 3, 5, 8]);

export const decl = q.decl`
  export const third = ${table}[2];
`;
