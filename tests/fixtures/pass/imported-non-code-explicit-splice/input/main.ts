import {q} from "typestage";
import {runtimeValue} from "./values";

// Intentional diagnostic: imported function values cannot be persisted.
export const expr = q.expr`
  ${runtimeValue} + 1
`;
