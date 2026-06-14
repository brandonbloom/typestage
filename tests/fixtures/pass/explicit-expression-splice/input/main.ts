import {q} from "typestage";

const lhs = q.expr`x + 1`;

export const expr = q.expr`
  ${lhs} * scale
`;
