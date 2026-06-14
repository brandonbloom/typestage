import {q} from "typestage";

const runtimeValue = {
  get value() {
    return 1;
  },
  [Symbol("x")]: 2,
};

// Intentional diagnostic: accessor properties cannot be persisted.
export const expr = q.expr`
  ${runtimeValue}
`;
