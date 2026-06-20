import {describe, expect, test} from "bun:test";
import * as ts from "typescript";
import {printNodes} from "./ast-print.ts";
import {q} from "./runtime.ts";
import {
  allIdentifierNames,
  prepareSubstitutionRecipient,
  Substitution,
} from "./substitution.ts";
import type {CodeValue, ParsedFragment, QuoteForm} from "./types.ts";

describe("Substitution", () => {
  test("renames recipient locals that would capture inserted free references", () => {
    const fragment = fragmentFromStatements(1, "snippet;\nconst x = 0;");
    const snippet = codeValue(2, "expr", [expressionNode("x + 1")]);
    const prepared = prepareSubstitutionRecipient({
      fragment,
      locals: new Set(["x"]),
      codeBindings: new Map([["snippet", snippet]]),
      values: new Map([[snippet.quote.id, snippet]]),
    });

    expect(printNodes(prepared)).toEqual("snippet;\nconst x_1 = 0;");
  });

  test("renames inserted locals that collide with occupied recipient names", () => {
    const fragment = fragmentFromStatements(1, "const x = 0;");
    const substitution = new Substitution({
      occupiedNames: new Set(["x"]),
      usedNames: allIdentifierNames(fragment.nodes),
    });
    const inserted = substitution.apply(statementNodes("const x = 1;"));

    expect(printNodes(inserted)).toEqual("const x_1 = 1;");
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

function statementNodes(text: string): ts.Node[] {
  return Array.from(sourceFileFor(text).statements);
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
