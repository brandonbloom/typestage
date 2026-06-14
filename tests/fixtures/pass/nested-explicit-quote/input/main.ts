import {q} from "typestage";

export const expr = q.expr`
  ${q.expr`1 + 1`} * 2
`;
