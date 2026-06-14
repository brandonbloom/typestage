import {q} from "typestage";

function compute() {
  return 42;
}

const runtimeValue = compute();

export const expr = q.expr`
  ${runtimeValue} + 1
`;
