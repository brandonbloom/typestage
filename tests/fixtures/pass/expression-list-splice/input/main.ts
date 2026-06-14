import {q} from "typestage";

const args = q.exprs`1, 2`;
const suffix = q.expr`3`;
const implicitArgs = q.exprs`4, 5`;
const implicitSuffix = q.expr`6`;

export const callExpr = q.expr`
  Math.max(0, ${args}, ${suffix}, implicitArgs, implicitSuffix, 3)
`;

export const newExpr = q.expr`
  new Array(${args})
`;
