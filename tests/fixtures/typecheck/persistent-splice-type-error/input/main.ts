import {q} from "typestage";

const value = 1;

export const decl = q.decl`
  export const checked = ${value} satisfies string;
`;
