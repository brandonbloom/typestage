import {q} from "typestage";

// IDEA: Design explicit residual globals inspired by Terra globals. A staging
// value should describe a generated or external residual binding with stable
// identity, type information, mutability, and a preferred emitted name.
const counter = q.global("counter", q.type`number`, {mutable: true, initial: 0});

export const decl = q.decl`
  export function next() {
    return ${counter}++;
  }
`;
