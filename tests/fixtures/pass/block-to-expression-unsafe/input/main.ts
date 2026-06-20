import {q} from "typestage";

const body = q.block`
  {
    await Promise.resolve();
    return 1;
  }
`;

// Intentional diagnostic: blocks containing await cannot adapt into expression positions.
export const expr = q.expr`
  body
`;
