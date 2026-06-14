import {q} from "typestage";

// Intentional diagnostic: misspelled ambient globals are rejected.
export const expr = q.expr`
  cosnole.log("typo")
`;
