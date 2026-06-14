import {q} from "typestage";

const compute = q.ident`compute`;

const body = q.block`
  {
    const value = compute();
    return value + 1;
  }
`;

export const expr = q.expr`
  ${body} * 2
`;
