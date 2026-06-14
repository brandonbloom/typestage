import {q} from "typestage";
import {call} from "./parts";

const args = q.exprs`1, 2`;

export const expr = q.expr`
  ${call(args)}
`;
