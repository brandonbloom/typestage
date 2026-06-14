import {q as quote} from "typestage";

const base = quote.expr`1 + 1`;

export const expr = quote.expr`
  base * 2
`;
