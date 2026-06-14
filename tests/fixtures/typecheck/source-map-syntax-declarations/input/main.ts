import {q} from "typestage";

export const decl = q.decl`
  export interface Named {
    name(): string;
  }

  export default class Box implements Named {
    private readonly value: string;

    public constructor(value: string) {
      this.value = value;
    }

    public static create(value: string): Box {
      return new Box(value);
    }

    public name(): string {
      return this.value;
    }
  }

  export type Alias = string;

  export enum Kind {
    One = "one",
  }
`;
