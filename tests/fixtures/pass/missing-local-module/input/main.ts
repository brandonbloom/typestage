import {q} from "typestage";

// Intentional diagnostic: the local module does not exist.
import {rhs} from "./missing";

export const expr = q.expr`
  rhs + 1
`;
