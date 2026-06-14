import * as ts from "typescript";

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

/** Prints a list of TypeScript statement nodes as a source file body. */
export function printNodes(nodes: readonly ts.Node[]): string {
  const sourceFile = ts.factory.createSourceFile(
    Array.from(nodes) as ts.Statement[],
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );

  return printer.printFile(sourceFile).trimEnd();
}

/** Prints a TypeScript expression node without adding a trailing semicolon. */
export function printExpression(expression: ts.Expression): string {
  const statement = ts.factory.createExpressionStatement(expression);
  const text = printer.printNode(
    ts.EmitHint.Unspecified,
    statement,
    emptySourceFile(),
  );

  return text.replace(/;\s*$/, "");
}

/** Prints a comma-separated list of TypeScript expression nodes. */
export function printExpressionList(expressions: readonly ts.Expression[]): string {
  return expressions.map(printExpression).join(", ");
}

/** Prints a single TypeScript AST node using the shared compiler printer. */
export function printNode(node: ts.Node): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, emptySourceFile());
}

function emptySourceFile(): ts.SourceFile {
  return ts.createSourceFile(
    "typestage.generated.ts",
    "",
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
}
