import {q} from "typestage";

const settings = {
  enabled: true,
  thresholds: new Map([
    ["low", 2],
    ["high", 10],
  ]),
  launchedAt: new Date("2026-06-13T00:00:00.000Z"),
};

export const expr = q.expr`
  settings
`;
