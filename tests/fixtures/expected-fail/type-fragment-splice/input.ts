import {q} from "typestage";

const Element = q.type`string`;

export const decl = q.decl`
  export type Box = Array<${Element}>;
`;
