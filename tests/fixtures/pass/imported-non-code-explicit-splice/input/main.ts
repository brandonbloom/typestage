import {q} from "typestage";
import {runtimeValue} from "./values";

export const expr = q.expr`
  ${runtimeValue} + 1
`;
