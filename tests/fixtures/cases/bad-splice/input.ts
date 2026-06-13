import {q} from "typestage";

const stmt = q.stmt`return x;`;

export const expr = q.expr`${stmt} + 1`;
