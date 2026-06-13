import {q} from "typestage";

const freeX = q.expr`x + 1`;

export const expr = q.expr`
  (() => {
    const x = 10;
    return freeX;
  })()
`;
