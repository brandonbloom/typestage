import {q} from "typestage";

const names = ["id", "name"];
const fieldDeclarations = names.map((name) => {
  const field = q.ident`${name}: string`;

  return q.decl`
    export const ${field} = ${name};
  `;
});

export const decls = q.decls`
  export const fieldCount = ${names.length};
  ${fieldDeclarations}
`;
