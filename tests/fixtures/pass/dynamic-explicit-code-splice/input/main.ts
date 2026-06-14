import {q} from "typestage";

function makeExpr() {
  return q.expr`x + 1`;
}

const runtimeExpr = makeExpr();

export const expr = q.expr`
  ${runtimeExpr} * 2
`;
