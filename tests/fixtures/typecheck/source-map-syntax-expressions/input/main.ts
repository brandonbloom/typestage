import {q} from "typestage";

export const decl = q.decl`
  export async function expressions(value: unknown) {
    const list = [1, 2, 3] as number[];
    const boxed = new Number(await Promise.resolve(1));
    const present = "length" in list;
    const yes = Boolean(true);
    const no = Boolean(false);

    if (boxed instanceof Number && present && yes !== no && null === null) {
      return list[0] satisfies number;
    }

    return value as number;
  }

  export function* generate() {
    yield 1;
  }
`;
