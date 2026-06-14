import {q} from "typestage";
import {value} from "./helper";

const valueRef = q.ident`value`;

export const decl = q.decl`
  export const result = valueRef();
`;
