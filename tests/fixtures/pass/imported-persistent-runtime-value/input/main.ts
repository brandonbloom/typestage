import {q} from "typestage";
import {settings} from "./settings";

export const expr = q.expr`
  configure(${settings})
`;
