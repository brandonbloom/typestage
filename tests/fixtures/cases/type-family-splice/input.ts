import {q} from "typestage";

const Element = q.type`string`;
const Params = q.types`number, boolean`;
const Result = q.type`Date`;

export const decl = q.decl`
  export type Box = Array<${Element}>;
  export type Tuple = [${Params}];
  export type Handler = Fn<${Params}, Result>;
`;
