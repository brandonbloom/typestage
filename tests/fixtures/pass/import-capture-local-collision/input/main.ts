import {q} from "typestage";
import {term} from "./parts";

export const decl = q.decl`
  export function run() {
    const make = () => 0;
    return term;
  }
`;
