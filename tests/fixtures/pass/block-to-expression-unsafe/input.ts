import {q} from "typestage";

const body = q.block`
  {
    await refresh();
    return value;
  }
`;

export const expr = q.expr`
  ${body}
`;
