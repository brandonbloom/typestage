import {q} from "typestage";

const runtimeValue = 42;

export const expr = q.expr`
  ${runtimeValue} + 1
`;
