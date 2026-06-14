import {q} from "typestage";

const x = q.ident`x`;
const y = q.ident`y`;
const setup = [
  q.stmt`const ${x} = 1;`,
  q.stmt`const ${y} = 2;`,
];

const body = q.stmts`
  ${setup}
  return x + y;
`;

export const fn = q.decl`
  export function sum() {
    ${body}
  }
`;
