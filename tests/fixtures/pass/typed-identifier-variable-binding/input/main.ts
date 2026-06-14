import {q} from "typestage";

const count = q.ident`count: number`;
const label = q.ident`label: string`;

export const decl = q.decl`
  export const ${count} = 1;
  export let ${label} = "one";
`;
