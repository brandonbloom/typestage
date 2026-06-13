import {q} from "typestage";

const body = q.stmt`
  return x;
`;

export const fn = q.decl`
  export function f(x: number) {
    ${body}
  }
`;
