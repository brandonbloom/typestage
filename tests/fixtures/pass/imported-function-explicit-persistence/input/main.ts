import {q} from "typestage";
import {makeValue} from "./helper";

// Intentional diagnostic: explicit splice means staging-time persistence.
export const expr = q.expr`
  ${makeValue}()
`;
