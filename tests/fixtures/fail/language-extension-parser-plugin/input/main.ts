import {q} from "typestage";

// IDEA: Design parser-extension hooks inspired by Terra language extensions.
// A future API could let libraries introduce tagged DSL syntax and lower it to
// TypeScript fragments with source origins for diagnostics and source maps.
const sql = q.language("sql", {
  expression(source: string) {
    return q.expr`query(${source})`;
  },
});

export const decl = q.decl`
  export const rows = ${sql.expr`select * from users where active = true`};
`;
