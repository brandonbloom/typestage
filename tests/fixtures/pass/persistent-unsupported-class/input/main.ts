import {q} from "typestage";

class Box {
  value = 1;
}

const runtimeValue = new Box();

// Intentional diagnostic: class instances cannot be persisted.
export const expr = q.expr`
  ${runtimeValue}
`;
