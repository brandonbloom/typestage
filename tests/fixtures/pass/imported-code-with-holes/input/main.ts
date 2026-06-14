import {q} from "typestage";
import {call} from "./parts";

const args = q.exprs`first, second`;

export const expr = q.expr`
  ${call(args)}
`;
