import {q} from "typestage";

const body = q.stmt`
  return x;
`;

export const fn = q.decl`
  // TODO: With explicit identifiers, prefer preserving this user-written
  // parameter name when the splice intentionally refers to it.
  export function f(x: number) {
    ${body}
  }
`;
