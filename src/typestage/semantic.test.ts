import {describe, expect, test} from "bun:test";
import {compileVirtualGraph} from "./graph.ts";

describe("semantic environment", () => {
  test("virtual graph compilation uses TypeScript libs for ambient globals", async () => {
    const result = await compileVirtualGraph([
      {
        fileName: "main.ts",
        source: `
          import {q} from "typestage";

          export const expr = q.expr\`
            Promise.resolve(Date.now())
          \`;
        `,
      },
    ], "main.ts");

    expect(result.diagnostics).toEqual([]);
    expect(result.files[0]!.outputText).toContain("Promise.resolve(Date.now())");
  });
});
