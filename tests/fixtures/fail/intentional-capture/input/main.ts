import {capture, q} from "typestage";

export const expr = q.expr`
  (() => {
    const x = 10;
    return ${capture("x")} + 1;
  })()
`;
