import {q} from "typestage";

const args = q.exprs`a, b`;
const suffix = q.expr`c`;
const implicitArgs = q.exprs`d, e`;
const implicitSuffix = q.expr`f`;

export const callExpr = q.expr`
  fn(0, ${args}, ${suffix}, implicitArgs, implicitSuffix, 3)
`;

export const newExpr = q.expr`
  new Box(${args})
`;
