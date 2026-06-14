import {q} from "typestage";
import {b} from "./parts";

// Intentional diagnostic: this quote and the imported quote recursively
// implicit-unquote each other.
export const a = q.expr`b + 1`;

export const expr = q.expr`
  a + 1
`;
