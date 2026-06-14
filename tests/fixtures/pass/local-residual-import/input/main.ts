import {q} from "typestage";
import {makeValue} from "./helper";

const makeValueRef = q.ident`makeValue`;

export const expr = q.expr`
  makeValueRef()
`;
