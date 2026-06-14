import {q} from "typestage";

const makeValue = q.ident`makeValue`;

// Intentional residual external reference: makeValue is supplied by the
// residual environment, not emitted by this fixture.
export const expr = q.expr`
  makeValue()
`;
