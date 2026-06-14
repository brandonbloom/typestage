import {q} from "typestage";

export const setup = q.stmt`
  const tmp = compute();
  use(tmp);
`;
