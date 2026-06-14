import {q} from "typestage";

const runtimeValue = () => 1;

// Intentional diagnostic: function values cannot be persisted.
export const expr = q.expr`
  ${runtimeValue}
`;
