import {q} from "typestage";
import {makeValue} from "./helper";

export const expr = q.expr`
  (() => {
    const makeValue = () => 2;
    return makeValue();
  })()
`;
