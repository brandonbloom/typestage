import {q} from "typestage";

export const expr = q.expr`
  ${q.expr`nested + 1`} * 2
`;
