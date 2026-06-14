import {q} from "typestage";

// Intentional diagnostic: helper.ts exists but does not export makeValue.
import {makeValue} from "./helper";

export const expr = q.expr`
  makeValue()
`;
