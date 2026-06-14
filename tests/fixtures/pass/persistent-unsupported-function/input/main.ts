import {q} from "typestage";

const runtimeValue = () => 1;

export const expr = q.expr`
  ${runtimeValue}
`;
