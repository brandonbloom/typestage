import {q} from "typestage";

const x = q.ident`x`;
const freeX = q.expr`x + 1`;

// Intentional residual free name: this fixture checks that hygiene preserves
// freeX's reference instead of allowing the nested local x to capture it.
export const expr = q.expr`
  ((x) => {
    return (() => {
      // The local x is renamed so it does not capture freeX's x.
      const x = 10;
      return freeX;
    })();
  })(1)
`;
