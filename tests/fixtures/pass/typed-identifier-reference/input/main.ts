import {q} from "typestage";

const input = q.ident`input: number`;

export const decl = q.decl`
  export function double(${input}) {
    return ${input} * 2;
  }
`;
