import {q} from "typestage";

const runtimeValue = {
  [Symbol("x")]: 1,
};

// Intentional diagnostic: objects with symbol keys cannot be persisted.
export const expr = q.expr`
  ${runtimeValue}
`;
