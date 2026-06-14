import {q} from "typestage";

const runtimeValue = {
  [Symbol("x")]: 1,
};

export const expr = q.expr`
  ${runtimeValue}
`;
