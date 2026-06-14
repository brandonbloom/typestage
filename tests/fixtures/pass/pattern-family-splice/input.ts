import {q} from "typestage";

const First = q.pattern`first`;
const Rest = q.patterns`second, {third}`;

export const decl = q.decl`
  export function collect(${First}, ${Rest}) {
    return [first, second, third];
  }
`;
