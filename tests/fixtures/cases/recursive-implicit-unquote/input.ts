import {q} from "typestage";

const a = q.expr`b + 1`;
const b = q.expr`a + 2`;

export const expr = q.expr`
  a
`;
