import {describe, expect, test} from "bun:test";
import * as ts from "typescript";
import {q, type RuntimeCode} from "./runtime.ts";
import {SpliceEvaluator} from "./splice-evaluator.ts";
import type {CodeValue, Diagnostic, ParsedFragment, QuoteForm, SpliceHole} from "./types.ts";

describe("SpliceEvaluator", () => {
  test("returns captured primitive values as persistent splice values", () => {
    const fragment = fragmentWithHole("value");
    const diagnostics: Diagnostic[] = [];
    const evaluator = new SpliceEvaluator(
      {
        capturedValues: new Map([[fragment.quote.id, [42]]]),
        values: new Map(),
      },
      fragment,
      new Map(),
      undefined,
      diagnostics,
    );

    expect(evaluator.evaluateSplice(fragment.quote.holes[0]!)).toEqual({
      kind: "persistent",
      value: 42,
    });
    expect(diagnostics).toEqual([]);
  });

  test("resolves uncaptured identifier holes through code bindings", () => {
    const fragment = fragmentWithHole("part");
    const code = codeValue(10, "expr", [expressionNode("x + 1")]);
    const evaluator = new SpliceEvaluator(
      {
        capturedValues: new Map(),
        values: new Map([[code.quote.id, code]]),
      },
      fragment,
      new Map([["part", code]]),
      undefined,
      [],
    );

    expect(evaluator.evaluateSplice(fragment.quote.holes[0]!)).toEqual({
      kind: "code",
      values: [code],
    });
  });

  test("maps runtime code values back to static code values", () => {
    const fragment = fragmentWithHole("part");
    const staticCode = codeValue(10, "expr", [expressionNode("x + 1")]);
    const runtimeCode: RuntimeCode = {
      __typestageRuntimeCode: true,
      cardinality: "one",
      kind: "expr",
      quoteId: staticCode.quote.id,
      strings: [""],
      text: "",
      values: ["captured"],
    };
    const evaluator = new SpliceEvaluator(
      {
        capturedValues: new Map([[fragment.quote.id, [runtimeCode]]]),
        values: new Map([[staticCode.quote.id, staticCode]]),
      },
      fragment,
      new Map(),
      undefined,
      [],
    );

    expect(evaluator.evaluateCodeSplice(fragment.quote.holes[0]!))
      .toEqual([{
        ...staticCode,
        runtimeValues: ["captured"],
        runtimeHostValues: undefined,
      }]);
  });

  test("emits a diagnostic when an uncaptured hole is not code-valued", () => {
    const fragment = fragmentWithHole("missing");
    const diagnostics: Diagnostic[] = [];
    const evaluator = new SpliceEvaluator(
      {
        capturedValues: new Map(),
        values: new Map(),
      },
      fragment,
      new Map(),
      undefined,
      diagnostics,
    );

    expect(evaluator.evaluateSplice(fragment.quote.holes[0]!)).toEqual({
      kind: "missing",
    });
    expect(diagnostics).toEqual([{
      code: "TSG1001",
      message: "explicit splice 'missing' does not resolve to a TypeStage code value",
      origin: {sourceFile: "test.ts", start: 0, end: 7},
    }]);
  });
});

function fragmentWithHole(expressionText: string): ParsedFragment {
  const expression = expressionNode(expressionText);
  const hole: SpliceHole = {
    expression,
    index: 0,
    origin: {sourceFile: "test.ts", start: 0, end: expressionText.length},
    placeholder: "__hole",
  };
  const quote = quoteForm(1, "expr", [hole]);

  return {
    fragmentStart: 0,
    nodes: [expression],
    originMap: [],
    quote,
    source: expressionText,
    sourceFile: expression.getSourceFile(),
    virtualFileName: "test.ts",
    virtualSource: expressionText,
  };
}

function codeValue(
  id: number,
  kind: CodeValue["kind"],
  nodes: ts.Node[],
): CodeValue {
  const quote = quoteForm(id, kind, []);
  const parsed: ParsedFragment = {
    fragmentStart: 0,
    nodes,
    originMap: [],
    quote,
    source: "",
    sourceFile: nodes[0]?.getSourceFile() ??
      ts.createSourceFile("empty.ts", "", ts.ScriptTarget.Latest, true),
    virtualFileName: "code.ts",
    virtualSource: "",
  };

  return {
    cardinality: "one",
    kind,
    parsed,
    quote,
  };
}

function quoteForm(
  id: number,
  kind: QuoteForm["kind"],
  holes: SpliceHole[],
): QuoteForm {
  return {
    exported: false,
    holes,
    id,
    kind,
    cardinality: "one",
    node: q.expr`` as unknown as ts.TaggedTemplateExpression,
    origin: {sourceFile: "test.ts", start: 0, end: 0},
    parts: [],
    template: q.expr`` as unknown as ts.TemplateLiteral,
  };
}

function expressionNode(text: string): ts.Expression {
  const sourceFile = ts.createSourceFile(
    "test.ts",
    `const value = ${text};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = sourceFile.statements[0];

  if (!statement || !ts.isVariableStatement(statement)) {
    throw new Error("expected variable statement");
  }

  const initializer = statement.declarationList.declarations[0]?.initializer;

  if (!initializer) {
    throw new Error("expected initializer");
  }

  return initializer;
}
