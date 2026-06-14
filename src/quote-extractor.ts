/**
 * Host-source scanner for TypeStage quote forms.
 * It recognizes imports of the runtime `q` namespace, records quote bodies
 * with placeholder holes, and attaches simple binding/export metadata before
 * fragment parsing.
 */
import * as ts from "typescript";
import {originForRange, originMapForText} from "./origin.ts";
import type {
  FragmentKind,
  Origin,
  QuoteCardinality,
  QuoteForm,
  SpliceHole,
  TemplatePart,
} from "./types.ts";

type QuoteTag = {
  cardinality: QuoteCardinality;
  kind: FragmentKind;
};

const quoteTags = new Map<string, QuoteTag>([
  ["expr", {cardinality: "one", kind: "expr"}],
  ["exprs", {cardinality: "many", kind: "expr"}],
  ["ident", {cardinality: "one", kind: "ident"}],
  ["type", {cardinality: "one", kind: "type"}],
  ["types", {cardinality: "many", kind: "type"}],
  ["pattern", {cardinality: "one", kind: "pattern"}],
  ["patterns", {cardinality: "many", kind: "pattern"}],
  ["stmt", {cardinality: "one", kind: "stmt"}],
  ["block", {cardinality: "one", kind: "block"}],
  ["decl", {cardinality: "one", kind: "decl"}],
]);

/** Parses host TypeScript source without interpreting quote contents. */
export function parseHostSource(sourceText: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** Finds recognized TypeStage quote forms in a parsed host source file. */
export function extractQuotes(sourceFile: ts.SourceFile): QuoteForm[] {
  const qNames = findTypeStageQNames(sourceFile);
  const quotes: QuoteForm[] = [];
  let nextQuoteId = 0;

  const visit = (node: ts.Node) => {
    if (ts.isTaggedTemplateExpression(node)) {
      const tag = quoteTag(node.tag, qNames);

      if (tag) {
        quotes.push(buildQuote(sourceFile, node, tag, nextQuoteId));
        nextQuoteId++;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  attachBindingNames(sourceFile, quotes);

  return quotes;
}

function findTypeStageQNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    if (!ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    if (statement.moduleSpecifier.text !== "typestage") {
      continue;
    }

    const namedBindings = statement.importClause?.namedBindings;

    if (!namedBindings || !ts.isNamedImports(namedBindings)) {
      continue;
    }

    for (const specifier of namedBindings.elements) {
      const imported = specifier.propertyName?.text ?? specifier.name.text;

      if (imported === "q") {
        names.add(specifier.name.text);
      }
    }
  }

  return names;
}

function quoteTag(tag: ts.LeftHandSideExpression, qNames: Set<string>) {
  if (!ts.isPropertyAccessExpression(tag)) {
    return undefined;
  }

  if (!ts.isIdentifier(tag.expression)) {
    return undefined;
  }

  if (!qNames.has(tag.expression.text)) {
    return undefined;
  }

  return quoteTags.get(tag.name.text);
}

function buildQuote(
  sourceFile: ts.SourceFile,
  node: ts.TaggedTemplateExpression,
  tag: QuoteTag,
  id: number,
): QuoteForm {
  const template = node.template;
  const parts: TemplatePart[] = [];
  const holes: SpliceHole[] = [];

  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    parts.push(templatePart(sourceFile, template, "`", "`"));
  } else {
    parts.push(templatePart(sourceFile, template.head, "`", "${"));

    for (const [index, span] of template.templateSpans.entries()) {
      const expressionStart = span.expression.getStart(sourceFile);
      holes.push({
        index,
        placeholder: `__typestage_hole_${id}_${index}`,
        expression: span.expression,
        origin: originForRange(
          sourceFile.fileName,
          expressionStart,
          span.expression.getEnd(),
        ),
      });

      parts.push(templatePart(sourceFile, span.literal, "}", span.literal.kind === ts.SyntaxKind.TemplateTail ? "`" : "${"));
    }
  }

  const start = node.getStart(sourceFile);

  return {
    id,
    cardinality: tag.cardinality,
    kind: tag.kind,
    node,
    template,
    origin: originForRange(sourceFile.fileName, start, node.getEnd()),
    parts,
    holes,
    exported: false,
  };
}

function templatePart(
  sourceFile: ts.SourceFile,
  literal: ts.TemplateLiteralLikeNode,
  leftDelimiter: string,
  rightDelimiter: string,
): TemplatePart {
  const raw = literal.getText(sourceFile);
  const startInLiteral = raw.startsWith(leftDelimiter) ? leftDelimiter.length : 0;
  const endInLiteral =
    rightDelimiter.length > 0 && raw.endsWith(rightDelimiter)
      ? raw.length - rightDelimiter.length
      : raw.length;
  const text = raw.slice(startInLiteral, endInLiteral);
  const contentStart = literal.getStart(sourceFile) + startInLiteral;

  return {
    text,
    originMap: originMapForText(sourceFile.fileName, contentStart, text),
  };
}

function attachBindingNames(sourceFile: ts.SourceFile, quotes: QuoteForm[]) {
  const byNode = new Map<ts.TaggedTemplateExpression, QuoteForm>();

  for (const quote of quotes) {
    byNode.set(quote.node, quote);
  }

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && byNode.has(node.initializer as ts.TaggedTemplateExpression)) {
      const quote = byNode.get(node.initializer as ts.TaggedTemplateExpression);

      if (quote && ts.isIdentifier(node.name)) {
        quote.bindingName = node.name.text;
        quote.exported = isExportedVariableDeclaration(node);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function isExportedVariableDeclaration(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;

  return (
    ts.isVariableStatement(statement) &&
    hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Reconstructs a quote body with stable placeholders for splice holes. */
export function quoteSource(quote: QuoteForm): {
  source: string;
  originMap: Array<Origin | undefined>;
} {
  let source = "";
  const originMap: Array<Origin | undefined> = [];

  for (const [index, part] of quote.parts.entries()) {
    source += part.text;
    originMap.push(...part.originMap);

    const hole = quote.holes[index];

    if (hole) {
      source += hole.placeholder;
      originMap.push(...Array.from({length: hole.placeholder.length}, () => hole.origin));
    }
  }

  return {source, originMap};
}
