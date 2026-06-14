import {q} from "typestage";

const lhs = q.expr`Number(1) + 1`;
const scale = q.expr`2`;

// This is the explicit-splice spelling of the implicit form:
//   q.expr`lhs * scale`
export const expr = q.expr`
  ${lhs} * ${scale}
`;
