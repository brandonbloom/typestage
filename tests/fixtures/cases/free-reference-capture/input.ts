import {q} from "typestage";

const freeX = q.expr`x + 1`;

export const expr = q.expr`
  (() => {
    // TODO: Explicit identifiers should let intentional capture preserve names;
    // bare free references still require this local binding to move.
    const x = 10;
    return freeX;
  })()
`;
