import {q} from "typestage";

// TODO: Consider supporting cycles by compiling persistent values to binding
// statements instead of requiring every value to fit in one expression.
const runtimeValue: {self?: unknown} = {};
runtimeValue.self = runtimeValue;

// Intentional diagnostic: cyclic object graphs cannot be persisted.
export const expr = q.expr`
  ${runtimeValue}
`;
