import {q} from "typestage";

const numberRef = q.ident`Number`;
const rhs = q.expr`numberRef(1)`;

export const expr = q.expr`
  rhs + 1
`;
