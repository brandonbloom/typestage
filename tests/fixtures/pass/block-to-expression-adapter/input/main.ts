import {q} from "typestage";

const body = q.block`
  {
    const value = 1;
    return value + 1;
  }
`;

export const expr = q.expr`
  body * 2
`;
