import {q} from "typestage";

// IDEA: Design pretty-print/debug APIs inspired by Terra's printpretty and
// quote tostring behavior. This would be useful in tests, diagnostics, and
// staging-time assertions without going through full pipeline snapshots.
const expr = q.expr`
  user.name.toUpperCase()
`;
const printed = q.pretty(expr);

export const decl = q.decl`
  export const debugText = ${printed};
`;
