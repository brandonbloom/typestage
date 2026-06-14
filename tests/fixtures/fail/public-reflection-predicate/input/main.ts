import {q} from "typestage";

// IDEA: Design public reflection predicates inspired by Terra's `isquote`,
// `issymbol`, `ismacro`, and similar helpers. User staging code should be able
// to branch on TypeStage runtime values without relying on private markers.
const value: unknown = q.expr`user.name`;

export const decl = q.decl`
  export const wasCode = ${q.isCode(value)};
`;
