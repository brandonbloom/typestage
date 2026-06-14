import {q} from "typestage";

const runtimeValue = Symbol("x");

// Intentional diagnostic: local symbol values cannot be persisted.
export const expr = q.expr`
  ${runtimeValue}
`;
