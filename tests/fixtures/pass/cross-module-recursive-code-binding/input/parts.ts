import {q} from "typestage";
import {a} from "./main";

// Other side of the intentional recursive implicit-unquote cycle.
export const b = q.expr`a + 1`;
