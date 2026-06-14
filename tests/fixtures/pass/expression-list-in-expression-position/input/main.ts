import {q} from "typestage";

const a = q.ident`a`;
const b = q.ident`b`;
const args = q.exprs`a, b`;

// Intentional diagnostic: expression lists do not implicitly adapt to comma
// expressions in scalar expression positions.
export const expr = q.expr`
  args + 1
`;
