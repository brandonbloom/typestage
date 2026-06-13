import {q} from "typestage";

const name = q.ident`fresh`;

export const decl = q.decl`
  const ${name} = 1;
  export const value = ${name};
`;
