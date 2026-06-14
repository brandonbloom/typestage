import {q} from "typestage";
import {settings} from "./settings";

const count = 3;

export const expr = q.expr`
  [count, ${settings}]
`;
