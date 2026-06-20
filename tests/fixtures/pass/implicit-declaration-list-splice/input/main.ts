import {q} from "typestage";

const decls = q.decls`
  export const first = 1;
  export const second = 2;
`;

export const module = q.decls`
  decls
`;
