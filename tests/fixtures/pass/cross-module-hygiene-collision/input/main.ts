import {q} from "typestage";
import {setup} from "./parts";

export const fn = q.decl`
  export function run() {
    const tmp = "outer";
    ${setup}
    return tmp;
  }
`;
