import {q} from "typestage";

const runtimeValue = Symbol.for("typestage.example");

export const expr = q.expr`
  ${runtimeValue}
`;
