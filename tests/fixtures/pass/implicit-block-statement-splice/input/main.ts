import {q} from "typestage";

const body = q.block`
  {
    const value = 1;
    return value;
  }
`;

export const fn = q.decl`
  export function f() {
    body
  }
`;
