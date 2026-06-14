import {q} from "typestage";

const First = q.pattern`first`;
const Rest = q.patterns`second, {third}`;
const first = q.ident`first`;
const second = q.ident`second`;
const third = q.ident`third`;

export const decl = q.decl`
  export const collect:
    (first: number, second: number, record: {third: number}) => number[] =
    function(${First}, ${Rest}) {
    return [first, second, third];
  };
`;
