import {describe, expect, test} from "bun:test";
import {compileRuntimeModule, q} from "typestage";

describe("compileRuntimeModule", () => {
  test("compiles runtime declaration fragments as modules", async () => {
    const program = q.decls`
      export const value = ${q.expr`1 + 2`};
    `;

    const result = await compileRuntimeModule(program, {
      outputPath: "main.ts",
      sourceMaps: true,
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!).toMatchObject({
      outputPath: "main.ts",
      outputText: "export const value = (1 + 2);\n",
    });
    expect(result.files[0]!.sourceMapText).toBeDefined();
  });

  test("persists runtime interpolation values", async () => {
    const value = {label: "demo", count: 2};
    const program = q.decls`
      export const value = ${value};
    `;

    const result = await compileRuntimeModule(program, {
      outputPath: "main.ts",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.outputText).toContain('label: "demo"');
    expect(result.files[0]!.outputText).toContain("count: 2");
  });

  test("resolves ambient globals from TypeScript config", async () => {
    const program = q.decls`
      export const value = Date.now();
      export function print() {
        console.log(new Map());
      }
    `;

    const result = await compileRuntimeModule(program, {
      outputPath: "main.ts",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.files[0]!.outputText).toContain("Date.now()");
    expect(result.files[0]!.outputText).toContain("console.log(new Map())");
  });
});
