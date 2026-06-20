import {q} from "typestage";

const x = q.ident`x`;

const body = q.stmt`
  return x;
`;

export const fn = q.decl`
  export function f(${x}: number) {
    body
  }
`;
