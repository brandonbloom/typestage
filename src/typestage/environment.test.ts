import {describe, expect, test} from "bun:test";
import * as ts from "typescript";
import {Environment} from "./environment.ts";
import {q} from "./runtime.ts";
import type {CodeValue, ParsedFragment, QuoteForm, ResidualImport} from "./types.ts";

describe("Environment", () => {
  test("resolves visible code bindings", () => {
    const fragment = fragmentFromStatements(1, "code;");
    const code = codeValue(2, "expr", [expressionNode("1")]);
    const identifier = expressionIdentifier(fragment);
    const environment = Environment.analyze(
      fragment,
      new Map([["code", code]]),
    );

    expect(environment.lookupValue(identifier)).toEqual({
      kind: "code",
      value: code,
    });
  });

  test("residual lexical bindings shadow code bindings", () => {
    const fragment = fragmentFromStatements(1, "const code = 1;\ncode;");
    const code = codeValue(2, "expr", [expressionNode("1")]);
    const identifier = expressionIdentifier(fragment);
    const environment = Environment.analyze(
      fragment,
      new Map([["code", code]]),
    );

    expect(environment.lookupValue(identifier)).toEqual({
      kind: "residual-local",
    });
  });

  test("records residual imports discovered by lookup", () => {
    const fragment = fragmentFromStatements(1, "imported;");
    const imported: ResidualImport = {
      imported: "sourceName",
      isTypeOnly: false,
      local: "imported",
      moduleId: "main.ts",
      specifier: "./dep",
    };
    const identifier = expressionIdentifier(fragment);
    const environment = Environment.analyze(
      fragment,
      new Map(),
      undefined,
      new Map([["imported", imported]]),
    );

    expect(environment.lookupValue(identifier)).toEqual({
      kind: "import",
      value: imported,
    });
    expect(Array.from(environment.residualImports.values())).toEqual([imported]);
  });
});

function fragmentFromStatements(id: number, text: string): ParsedFragment {
  const sourceFile = sourceFileFor(text);
  const quote = quoteForm(id);

  return {
    fragmentStart: 0,
    nodes: Array.from(sourceFile.statements),
    originMap: [],
    quote,
    source: text,
    sourceFile,
    virtualFileName: "test.ts",
    virtualSource: text,
  };
}

function codeValue(
  id: number,
  kind: CodeValue["kind"],
  nodes: ts.Node[],
): CodeValue {
  const quote = quoteForm(id);
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

function quoteForm(id: number): QuoteForm {
  return {
    exported: false,
    holes: [],
    id,
    kind: "stmt",
    cardinality: "one",
    node: q.expr`` as unknown as ts.TaggedTemplateExpression,
    origin: {sourceFile: "test.ts", start: 0, end: 0},
    parts: [],
    template: q.expr`` as unknown as ts.TemplateLiteral,
  };
}

function expressionIdentifier(fragment: ParsedFragment): ts.Identifier {
  const statement = fragment.nodes.find(ts.isExpressionStatement);

  if (!statement || !ts.isIdentifier(statement.expression)) {
    throw new Error("expected identifier expression statement");
  }

  return statement.expression;
}

function expressionNode(text: string): ts.Expression {
  const sourceFile = sourceFileFor(`const value = ${text};`);
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

function sourceFileFor(text: string): ts.SourceFile {
  return ts.createSourceFile(
    "test.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}
