import {q} from "typestage";

const runtimeValue = {
  get value() {
    return 1;
  },
  [Symbol("x")]: 2,
};

export const expr = q.expr`
  ${runtimeValue}
`;
