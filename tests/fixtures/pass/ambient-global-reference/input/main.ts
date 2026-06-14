import {q} from "typestage";

export const expr = q.expr`
  Promise.resolve(Date.now())
`;
