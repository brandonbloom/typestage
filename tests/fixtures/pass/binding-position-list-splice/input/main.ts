import {q} from "typestage";

const a = q.ident`a: number`;
const b = q.ident`b: number`;
const params = [a, b];

export const decl = q.decl`
  export function sum(${params}) {
    return a + b;
  }
`;
