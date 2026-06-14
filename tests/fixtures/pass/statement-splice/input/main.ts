import {q} from "typestage";

const body = q.stmt`
  const value = compute();
  return value;
`;

export const fn = q.decl`
  export function f() {
    ${body}
  }
`;
