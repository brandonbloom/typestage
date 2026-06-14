import {q} from "typestage";

const stmt = q.stmt`return "literal";`;

// Intentional diagnostic: statement fragments cannot splice into expression positions.
export const expr = q.expr`${stmt} + 1`;
