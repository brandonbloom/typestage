import {describe, expect, test} from "bun:test";
import {
  compileRuntimeModule,
  originalPositionForGeneratedLocation,
  q,
} from "typestage";

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

  test("maps external runtime origins through source maps", async () => {
    const source = `(value "boom")`;
    const origin = {
      sourceFile: "source.lisp",
      start: source.indexOf("boom"),
      end: source.indexOf("boom") + "boom".length,
    };
    const literal = q.withOrigin(q.expr`${"boom"}`, origin);
    const program = q.decls`
      export const value = ${literal};
    `;

    const result = await compileRuntimeModule(program, {
      outputPath: "main.ts",
      sourceMaps: true,
      sources: {"source.lisp": source},
    });

    const outputText = result.files[0]!.outputText;
    const line = outputText.split("\n")
      .findIndex((candidate) => candidate.includes("boom")) + 1;
    const column = outputText.split("\n")[line - 1]!.indexOf("boom") + 1;
    const original = originalPositionForGeneratedLocation(
      result.files[0]!.sourceMapText!,
      line,
      column,
    );

    expect(original).toEqual({
      column: source.indexOf("boom") + 1,
      line: 1,
      sourceFile: "source.lisp",
    });
  });
});
