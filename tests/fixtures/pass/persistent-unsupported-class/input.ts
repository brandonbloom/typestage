import {q} from "typestage";

class Box {
  value = 1;
}

const runtimeValue = new Box();

export const expr = q.expr`
  ${runtimeValue}
`;
