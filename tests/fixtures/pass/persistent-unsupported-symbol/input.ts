import {q} from "typestage";

const runtimeValue = Symbol("x");

export const expr = q.expr`
  ${runtimeValue}
`;
