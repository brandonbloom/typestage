import {q} from "typestage";

const setup = q.stmt`
  const tmp = "inner";
  String(tmp);
`;

export const fn = q.decl`
  export function run() {
    const tmp = "outer";
    setup
    return tmp;
  }
`;
