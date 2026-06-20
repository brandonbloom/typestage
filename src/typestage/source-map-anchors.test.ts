import {describe, expect, test} from "bun:test";
import * as ts from "typescript";
import {originForRange, setNodeOrigin} from "./origin.ts";
import {sourceMapAnchorsForBlock} from "./source-map-anchors.ts";

describe("sourceMapAnchorsForBlock", () => {
  test("recovers syntax keyword origins from matching source ranges", () => {
    const sourceText = "export const value = 1;\n";
    const sourceFile = sourceFileFor(sourceText);

    const anchors = sourceMapAnchorsForBlock(
      {
        sourceFile,
        statements: Array.from(sourceFile.statements),
        text: sourceText.trimEnd(),
      },
      sourceTextForFile(sourceText),
    );

    expect(anchorStarts(anchors)).toContain(sourceText.indexOf("export"));
    expect(anchorStarts(anchors)).toContain(sourceText.indexOf("const"));
    expect(anchorStarts(anchors)).toContain(sourceText.indexOf("value"));
  });

  test("uses explicit node origins for rewritten identifiers", () => {
    const sourceText = "const x = 1;\n";
    const identifier = setNodeOrigin(
      ts.factory.createIdentifier("x_1"),
      originForRange("input.ts", sourceText.indexOf("x"), sourceText.indexOf("x") + 1),
    );
    const statement = ts.factory.createVariableStatement(
      undefined,
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            identifier,
            undefined,
            undefined,
            ts.factory.createNumericLiteral("1"),
          ),
        ],
        ts.NodeFlags.Const,
      ),
    );

    const anchors = sourceMapAnchorsForBlock(
      {
        statements: [statement],
        text: "const x_1 = 1;",
      },
      sourceTextForFile(sourceText),
    );
    const rewritten = anchors.find((anchor) => anchor.generatedColumn === 6);

    expect(rewritten?.origin.start).toBe(sourceText.indexOf("x"));
  });
});

function anchorStarts(anchors: ReturnType<typeof sourceMapAnchorsForBlock>): number[] {
  return anchors.map((anchor) => anchor.origin.start);
}

function sourceFileFor(text: string): ts.SourceFile {
  return ts.createSourceFile(
    "input.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function sourceTextForFile(text: string): (sourceFile: string) => string {
  return (sourceFile: string) => {
    if (sourceFile !== "input.ts") {
      throw new Error(`unexpected source file ${sourceFile}`);
    }

    return text;
  };
}
