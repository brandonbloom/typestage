import {q} from "typestage";

const runtimeExpr = q.expr`1`;

export const expr = q.expr`
  ${runtimeExpr} + 1
`;
