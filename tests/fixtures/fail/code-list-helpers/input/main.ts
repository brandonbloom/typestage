import {q} from "typestage";

// IDEA: Design small code-list helpers inspired by Terra's List API. Plain
// arrays work, but staging code often wants map/filter/flatMap over fragments
// with kind/cardinality checks and better diagnostics.
const fields = q.list(["id", "name"]).map((name) => q.decl`
  export const ${q.identifier(name)} = ${name};
`);

export const decls = q.decls`${fields}`;
