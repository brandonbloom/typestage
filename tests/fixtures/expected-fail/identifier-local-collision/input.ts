import {q} from "typestage";

const tmp = q.ident`tmp`;

const setup = q.stmt`
  const ${tmp} = compute();
  use(${tmp});
`;

export const fn = q.decl`
  export function run() {
    const tmp = "outer";
    ${setup}
    return tmp;
  }
`;
