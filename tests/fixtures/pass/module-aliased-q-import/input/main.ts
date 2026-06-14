import {q as stage} from "typestage";

const value = stage.expr`1`;

export const expr = stage.expr`
  value + 1
`;
