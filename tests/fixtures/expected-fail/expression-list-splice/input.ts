import {q} from "typestage";

const args = q.exprs`a, b`;

export const expr = q.expr`
  fn(${args})
`;
