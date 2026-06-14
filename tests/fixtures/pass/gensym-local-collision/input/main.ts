import {q} from "typestage";

const tmpName = q.ident`tmp`;
const setup = q.stmt`
  const ${tmpName} = "inner";
  String(${tmpName});
`;

export const fn = q.decl`
  export function run() {
    const tmp = "outer";
    ${setup}
    return tmp;
  }
`;
