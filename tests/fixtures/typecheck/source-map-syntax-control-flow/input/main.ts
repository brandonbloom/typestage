import {q} from "typestage";

export const decl = q.decl`
  export function control(input: number): number {
    let total = 0;

    if (input > 0) {
      total = input;
    } else {
      total = -input;
    }

    for (let index = 0; index < 3; index++) {
      switch (index) {
        case 0:
          total += index;
          break;
        default:
          continue;
      }
    }

    try {
      return total;
    } catch (error) {
      throw error;
    } finally {
      total;
    }
  }
`;
