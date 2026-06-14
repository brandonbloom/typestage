import {q} from "typestage";

const args = q.exprs`a, b`;

export const expr = q.expr`
  // Lists do not implicitly adapt to comma expressions.
  args + 1
`;
