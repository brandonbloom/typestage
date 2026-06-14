import {q} from "typestage";

// IDEA: Design quote introspection inspired by Terra's quote methods such as
// gettype, astype, islvalue, asvalue, and printpretty. This would let staging
// code inspect generated fragments before choosing residual code.
const expr = q.expr`value + 1`;
const isAssignable = q.isLValue(expr);

export const decl = q.decl`
  export const canAssign = ${isAssignable};
`;
