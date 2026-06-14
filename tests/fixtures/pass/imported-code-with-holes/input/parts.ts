import {q} from "typestage";

export function call(args: unknown) {
  return q.expr`fn(${args})`;
}
