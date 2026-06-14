import {q} from "typestage";

const runtimeValue = {
  values: [undefined, NaN, Infinity, -Infinity, -0, 1n],
  nested: {ok: true},
  set: new Set(["a", "b"]),
  pattern: /ab+/gi,
};

export const expr = q.expr`
  runtimeValue
`;
