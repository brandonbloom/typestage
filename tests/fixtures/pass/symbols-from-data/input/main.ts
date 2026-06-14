import {q} from "typestage";

const fieldNames = ["id", "name", "email"];
const fields = fieldNames.map((fieldName) => q.ident`${fieldName}: string`);
const trimmedFields = fields.map((field) => q.expr`${field}.trim()`);

export const decl = q.decl`
  export function packFields(${fields}) {
    return pack(${trimmedFields});
  }
`;
