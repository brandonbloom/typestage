import {q} from "typestage";

// IDEA: Design typecheck-aware compile-time macros inspired by Terra macros.
// Macro arguments should be code values, and the macro result should splice
// back into the surrounding quote after inspecting those arguments.
const twice = q.macro((input: unknown) => q.expr`${input} + ${input}`);

export const decl = q.decl`
  export const value = ${twice(q.expr`21`)};
`;
