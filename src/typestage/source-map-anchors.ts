import {LinesAndColumns} from "lines-and-columns";
import * as ts from "typescript";
import {getNodeOrigin, originForRange} from "./origin.ts";
import type {Origin} from "./types.ts";

export type SourceMapAnchorBlock = {
  origin?: Origin;
  sourceFile?: ts.SourceFile;
  statements: readonly ts.Statement[];
  text: string;
};

export type SourceMapAnchor = {
  generatedColumn: number;
  generatedLine: number;
  origin: Origin;
};

type GeneratedToken = {
  column: number;
  kind: ts.SyntaxKind;
  line: number;
  text: string;
};

type OriginToken = {
  kind: ts.SyntaxKind;
  origin: Origin;
  text: string;
};

const emptySourceFile = ts.createSourceFile(
  "typestage-generated.ts",
  "",
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

/**
 * Finds generated token positions that can be anchored to original source ranges.
 *
 * TypeScript's printer does not expose printed byte ranges for AST nodes, so
 * this layer is the narrow bridge from printed residual text back to origin
 * metadata. Explicit node origins are authoritative; whole source-range scans
 * recover syntax tokens the AST does not expose; greedy token matching is the
 * fallback for locating those anchors in printed output.
 */
export function sourceMapAnchorsForBlock(
  block: SourceMapAnchorBlock,
  sourceTextForFile: (sourceFile: string) => string,
): SourceMapAnchor[] {
  const generatedTokens = generatedInterestingTokens(block.text);
  const originTokens = block.statements.flatMap((statement) =>
    originInterestingTokens(statement, block.sourceFile, sourceTextForFile)
  );
  const anchors: SourceMapAnchor[] = block.origin
    ? [{generatedColumn: 0, generatedLine: 0, origin: block.origin}]
    : [];
  let generatedIndex = 0;

  for (const originToken of originTokens) {
    const matchedIndex = generatedTokens.findIndex((token, index) =>
      index >= generatedIndex && token.text === originToken.text
    );

    if (matchedIndex < 0) {
      continue;
    }

    const generated = generatedTokens[matchedIndex]!;

    anchors.push({
      generatedColumn: generated.column,
      generatedLine: generated.line,
      origin: originToken.origin,
    });
    generatedIndex = matchedIndex + 1;
  }

  return anchors;
}

/**
 * Extracts the printed tokens we use as source-map anchors.
 * "Interesting" tokens are stable, user-visible syntax with useful diagnostic
 * ownership: identifiers, literals, and TypeScript keywords. Punctuation and
 * operators are deliberately excluded because they are often introduced,
 * removed, or moved by printing and by TypeStage wrappers.
 */
function generatedInterestingTokens(text: string): GeneratedToken[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const lines = new LinesAndColumns(text);
  const tokens: GeneratedToken[] = [];

  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const token = scanner.getToken();

    if (!isInterestingTokenKind(token)) {
      continue;
    }

    const position = scanner.getTokenPos();
    const location = lines.locationForIndex(position);

    if (location) {
      tokens.push({
        column: location.column,
        kind: token,
        line: location.line,
        text: scanner.getTokenText(),
      });
    }
  }

  return tokens;
}

/**
 * Builds source-side token anchors for a residual AST subtree.
 * The fast path scans the node's whole original source range, but only when
 * that range would print to the same interesting-token sequence as the
 * generated node. That preserves keywords the AST does not expose as child
 * nodes, such as `export`, `const`, or `satisfies`. When the token shape does
 * not match, as with splices, hygiene renames, or synthetic adapters, we fall
 * back to the node's own origin and recursively map children so generated
 * tokens keep the more precise origins attached during expansion.
 */
function originInterestingTokens(
  root: ts.Node,
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): OriginToken[] {
  const tokens: OriginToken[] = [];

  const visit = (node: ts.Node) => {
    const origin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);
    const scanOrigin = originForTokenScan(node, sourceFile) ?? origin;

    if (scanOrigin) {
      const sourceTokens = sourceRangeInterestingTokens(scanOrigin, sourceTextForFile);

      if (
        canUseCompleteSourceRangeTokens(
          node,
          scanOrigin,
          sourceTokens,
          sourceFile,
          sourceTextForFile,
        )
      ) {
        tokens.push(...sourceTokens);
        return;
      }

      if (isInterestingTokenKind(node.kind)) {
        const tokenOrigin = origin ?? scanOrigin;

        tokens.push({
          kind: node.kind,
          origin: tokenOrigin,
          text: tokenText(node, sourceFile, sourceTextForFile),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);

  return tokens;
}

function originForTokenScan(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): Origin | undefined {
  const nodeOrigin = getNodeOrigin(node);
  const sourceOrigin = originForSourceNode(node, sourceFile);

  if (
    nodeOrigin &&
    sourceOrigin &&
    sourceOrigin.sourceFile === nodeOrigin.sourceFile &&
    sourceOrigin.start <= nodeOrigin.start &&
    sourceOrigin.end >= nodeOrigin.end
  ) {
    return sourceOrigin;
  }

  return nodeOrigin ?? sourceOrigin;
}

function sourceRangeInterestingTokens(
  origin: Origin,
  sourceTextForFile: (sourceFile: string) => string,
): OriginToken[] {
  const sourceText = sourceTextForFile(origin.sourceFile);
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    sourceText.slice(origin.start, origin.end),
  );
  const tokens: OriginToken[] = [];

  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    const kind = scanner.getToken();

    if (!isInterestingTokenKind(kind)) {
      continue;
    }

    const start = origin.start + scanner.getTokenPos();

    tokens.push({
      kind,
      origin: {
        sourceFile: origin.sourceFile,
        start,
        end: start + scanner.getTokenText().length,
      },
      text: scanner.getTokenText(),
    });
  }

  return tokens;
}

function canUseCompleteSourceRangeTokens(
  node: ts.Node,
  origin: Origin,
  sourceTokens: OriginToken[],
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): boolean {
  if (sourceTokens.length === 0) {
    return false;
  }

  const sourceText = sourceTextForFile(origin.sourceFile)
    .slice(origin.start, origin.end);

  return (
    !sourceText.includes("${") &&
    !sourceText.includes("__typestage_hole_") &&
    hasSameInterestingTokenShape(
      node,
      sourceTokens,
      sourceFile,
    ) &&
    !hasDescendantTokenMismatch(node, origin, sourceFile, sourceTextForFile)
  );
}

function hasSameInterestingTokenShape(
  node: ts.Node,
  sourceTokens: OriginToken[],
  sourceFile: ts.SourceFile | undefined,
): boolean {
  const generatedTokens = generatedNodeInterestingTokens(node, sourceFile);

  return generatedTokens.length === sourceTokens.length &&
    generatedTokens.every((token, index) => {
      const sourceToken = sourceTokens[index]!;

      return token.kind === sourceToken.kind && token.text === sourceToken.text;
    });
}

function generatedNodeInterestingTokens(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): Array<Pick<GeneratedToken, "kind" | "text">> {
  const printed = ts.createPrinter({removeComments: true}).printNode(
    emitHintForNode(node),
    node,
    sourceFile ?? emptySourceFile,
  );

  return generatedInterestingTokens(printed).map((token) => ({
    kind: token.kind,
    text: token.text,
  }));
}

function emitHintForNode(node: ts.Node): ts.EmitHint {
  if (ts.isExpression(node)) {
    return ts.EmitHint.Expression;
  }

  if (ts.isIdentifier(node)) {
    return ts.EmitHint.Expression;
  }

  return ts.EmitHint.Unspecified;
}

function hasDescendantTokenMismatch(
  root: ts.Node,
  origin: Origin,
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): boolean {
  let mismatch = false;

  const visit = (node: ts.Node) => {
    if (mismatch || node === root) {
      ts.forEachChild(node, visit);
      return;
    }

    if (isInterestingTokenKind(node.kind)) {
      const nodeOrigin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);

      if (
        !nodeOrigin ||
        nodeOrigin.sourceFile !== origin.sourceFile ||
        nodeOrigin.start < origin.start ||
        nodeOrigin.end > origin.end
      ) {
        mismatch = true;
        return;
      }

      const sourceTokenText = sourceTextForFile(nodeOrigin.sourceFile)
        .slice(nodeOrigin.start, nodeOrigin.end);
      const generatedTokenText = tokenText(node, sourceFile, sourceTextForFile);

      if (sourceTokenText !== generatedTokenText) {
        mismatch = true;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(root);

  return mismatch;
}

function originForSourceNode(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): Origin | undefined {
  if (!sourceFile || node.pos < 0 || node.end < 0) {
    return undefined;
  }

  return originForRange(
    sourceFile.fileName,
    node.getStart(sourceFile),
    node.getEnd(),
  );
}

function tokenText(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
  sourceTextForFile: (sourceFile: string) => string,
): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }

  const origin = getNodeOrigin(node) ?? originForSourceNode(node, sourceFile);

  if (origin) {
    return node.pos >= 0
      ? sourceTextForFile(origin.sourceFile).slice(origin.start, origin.end)
      : syntheticTokenText(node, sourceFile);
  }

  return sourceFile ? node.getText(sourceFile) : tokenTextForKind(node.kind);
}

function syntheticTokenText(
  node: ts.Node,
  sourceFile: ts.SourceFile | undefined,
): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }

  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) {
    return node.text;
  }

  if (ts.isStringLiteral(node)) {
    return JSON.stringify(node.text);
  }

  if (ts.isRegularExpressionLiteral(node)) {
    return sourceFile ? node.getText(sourceFile) : "";
  }

  return tokenTextForKind(node.kind);
}

function tokenTextForKind(kind: ts.SyntaxKind): string {
  switch (kind) {
    case ts.SyntaxKind.TrueKeyword:
      return "true";

    case ts.SyntaxKind.FalseKeyword:
      return "false";

    case ts.SyntaxKind.NullKeyword:
      return "null";

    default:
      return ts.tokenToString(kind) ?? "";
  }
}

/** Returns whether a scanner token is useful enough to anchor a mapping. */
function isInterestingTokenKind(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.Identifier ||
    kind === ts.SyntaxKind.NumericLiteral ||
    kind === ts.SyntaxKind.BigIntLiteral ||
    kind === ts.SyntaxKind.StringLiteral ||
    kind === ts.SyntaxKind.RegularExpressionLiteral ||
    isKeywordTokenKind(kind)
  );
}

function isKeywordTokenKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword;
}
