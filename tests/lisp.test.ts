import {describe, expect, test} from "bun:test";
import {formatGraphDiagnostics, originalPositionForGeneratedLocation} from "typestage";
import {
  compileLispSourceToTypeScript,
  evaluateTypeScript,
  formatJsonValue,
  ReplRuntime,
} from "../examples/lisp/src/driver.ts";
import {parseProgram} from "../examples/lisp/src/sexpr.ts";

const sampleProgram = `(define base 10)
(define (square x) (* x x))
(define (offsetSquare x)
  (define base 2)
  (+ (square x) base))
(define result (offsetSquare 4))
(define (fail) (throw "boom"))
(define (main)
  (print result)
  (fail))
`;

describe("Lisp example", () => {
  test("parses trivial s-expressions", () => {
    const parsed = parseProgram(`(+ 1 "two" #true #false #null)`);

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.forms).toHaveLength(1);
    expect(parsed.forms[0]).toMatchObject({
      items: [
        {kind: "symbol", name: "+"},
        {kind: "number", value: 1},
        {kind: "string", value: "two"},
        {kind: "boolean", value: true},
        {kind: "boolean", value: false},
        {kind: "null"},
      ],
      kind: "list",
    });
  });

  test("compiles a tiny program through the runtime TypeStage API", async () => {
    const result = await compileLispSourceToTypeScript(sampleProgram, {
      sourceFile: "sample.lisp",
    });

    expect(formatGraphDiagnostics(result.graph.diagnostics)).toEqual([]);
    expect(result.outputText).toEqual(`export const base = 10;
export function square(x: any) {
    return (x * x);
}
export function offsetSquare(x_1: any) {
    const base_1 = 2;
    return (square(x_1) + base_1);
}
export const result = offsetSquare(4);
export function fail() {
    return (() => {
        throw "boom";
    })();
}
export function main() {
    console.log(result);
    return fail();
}
`);
  });

  test("throw source maps show the generated-origin limitation", async () => {
    const result = await compileLispSourceToTypeScript(sampleProgram, {
      sourceFile: "sample.lisp",
      sourceMaps: true,
    });

    expect(result.outputText).toContain("throw");
    expect(result.sourceMapText).toBeDefined();

    const outputLines = result.outputText!.split("\n");
    const throwLine = outputLines.findIndex((line) => line.includes("throw")) + 1;
    const throwColumn = outputLines[throwLine - 1]!.indexOf("boom") + 1;
    const original = originalPositionForGeneratedLocation(
      result.sourceMapText!,
      throwLine,
      throwColumn,
    );
    const sourceMap = JSON.parse(result.sourceMapText!) as {sources: string[]};

    expect(original?.sourceFile).toBe("sample.lisp.generated.ts");
    expect(sourceMap.sources).not.toContain("sample.lisp");
  });

  test("reports Lisp diagnostics through the runtime TypeStage API", async () => {
    const result = await compileLispSourceToTypeScript(`(+ 1)`, {
      sourceFile: "bad.lisp",
    });

    expect(formatGraphDiagnostics(result.graph.diagnostics).join("\n"))
      .toContain("LISP2015");
  });

  test("compiles REPL globals inside do expressions", async () => {
    const result = await compileLispSourceToTypeScript(`(do (define y 2) (+ x y))`, {
      globals: ["x"],
    });

    expect(formatGraphDiagnostics(result.graph.diagnostics)).toEqual([]);
    expect(result.outputText).toEqual(`export const result0 = (() => {
    const y = 2;
    return (x + y);
})();
`);
  });

  test("compiles booleans null if and do", async () => {
    const result = await compileLispSourceToTypeScript(`(if #true
  (do
    (define x 1)
    (+ x 2))
  #null)`);

    expect(formatGraphDiagnostics(result.graph.diagnostics)).toEqual([]);
    expect(result.outputText).toEqual(`export const result0 = ((true) ? (() => {
    const x = 1;
    return (x + 2);
})() : (null));
`);
  });

  test("evaluates generated TypeScript for the REPL", async () => {
    const result = await compileLispSourceToTypeScript(`(define (main)
  (define x 2)
  (print (+ x 3))
  (* x 4))`);

    expect(result.outputText).toBeDefined();

    const evaluation = await evaluateTypeScript(result.outputText!);

    expect(evaluation.logs).toEqual(["5"]);
    expect(evaluation.resultLabel).toBe("main");
    expect(evaluation.result).toBe(8);
    expect(evaluation.threw).toBeUndefined();
  });

  test("evaluates each REPL input as a module with hidden namespace imports", async () => {
    const runtime = await ReplRuntime.create();

    try {
      const first = await compileLispSourceToTypeScript(`(define x 1)`);
      const second = await compileLispSourceToTypeScript(`x`, {
        globals: ["x"],
      });

      expect(first.outputText).toEqual("export const x = 1;\n");
      expect(second.outputText).toEqual("export const result0 = x;\n");

      const firstEvaluation = await runtime.evaluate(first.outputText!);
      const secondEvaluation = await runtime.evaluate(second.outputText!);

      expect(firstEvaluation.result).toBeNull();
      expect(firstEvaluation.resultLabel).toBe("define");
      expect(secondEvaluation.resultLabel).toBe("result0");
      expect(secondEvaluation.result).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  test("reports unknown symbols before TypeStage emits residual code", async () => {
    const result = await compileLispSourceToTypeScript(`missing`);

    expect(formatGraphDiagnostics(result.graph.diagnostics).join("\n"))
      .toContain("LISP2020");
  });

  test("formats values as pretty JSON", () => {
    expect(formatJsonValue({value: [1, "two"]})).toEqual(`{
  "value": [
    1,
    "two"
  ]
}`);
  });
});
