import {q} from "typestage";

const runtimeExpr = q.expr`x`;

export const expr = q.expr`
  ${runtimeExpr} + 1
`;
