import {q} from "typestage";

// IDEA: Design richer compile-time conversion rules inspired by Terra's value
// conversion table. Objects could opt into persistence by returning a TypeStage
// expression instead of being rejected as unsupported class instances.
class Endpoint {
  constructor(readonly path: string) {}

  toTypeStageExpression() {
    return q.expr`new URL(${this.path}, "https://example.com")`;
  }
}

const endpoint = new Endpoint("/users");

export const decl = q.decl`
  export const url = ${endpoint};
`;
