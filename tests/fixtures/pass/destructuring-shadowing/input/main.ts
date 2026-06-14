import {q} from "typestage";

const y = q.ident`y`;
const rhs = q.expr`y + 1`;

export const expr = q.expr`
  (() => {
    // bag is a residual local so the fixture isolates destructuring shadowing:
    // the binding named rhs below must shadow the staging code binding rhs.
    const bag = {rhs: 1};
    const {rhs} = bag;
    return rhs;
  })()
`;
