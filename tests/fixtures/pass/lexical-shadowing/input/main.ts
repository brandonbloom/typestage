import {q} from "typestage";

const y = q.ident`y`;
const rhs = q.expr`y + 1`;

export const expr = q.expr`
  (() => {
    const rhs = 1;
    return rhs;
  })()
`;
