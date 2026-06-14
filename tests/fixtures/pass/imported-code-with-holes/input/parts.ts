import {q} from "typestage";

const fn = q.expr`Math.max`;

export function call(args: unknown) {
  return q.expr`fn(${args})`;
}
