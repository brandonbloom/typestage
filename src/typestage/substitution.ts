import * as ts from "typescript";
import {copyNodeOrigin} from "./origin.ts";
import {
  collectLocalBindingNames,
  freeReferenceNames,
  isReferenceIdentifier,
} from "./residual-scope.ts";
import {codeValueForExpression} from "./splice-evaluator.ts";
import type {CodeValue, ParsedFragment} from "./types.ts";

export type PrepareSubstitutionRecipientOptions = {
  fragment: ParsedFragment;
  locals: Set<string>;
  codeBindings: Map<string, CodeValue>;
  values: Map<number, CodeValue>;
};

/** Renames recipient bindings that would capture free references from substitutions. */
export function prepareSubstitutionRecipient(
  options: PrepareSubstitutionRecipientOptions,
): ts.Node[] {
  const captureRenames = captureAvoidanceRenames(
    options.fragment,
    options.locals,
    options.codeBindings,
    options.values,
  );

  return captureRenames.size > 0
    ? renameIdentifiers(options.fragment.nodes, captureRenames)
    : options.fragment.nodes;
}

export type SubstitutionOptions = {
  occupiedNames: Set<string>;
  usedNames: Set<string>;
};

/** Applies capture-avoiding replacements into one residual fragment. */
export class Substitution {
  private readonly occupiedNames: Set<string>;
  private readonly usedNames: Set<string>;

  constructor(options: SubstitutionOptions) {
    this.occupiedNames = new Set(options.occupiedNames);
    this.usedNames = new Set(options.usedNames);
  }

  apply(nodes: ts.Node[]): ts.Node[] {
    const localNames = collectLocalBindingNames(nodes);
    const conflicts = Array.from(localNames)
      .filter((name) => this.occupiedNames.has(name))
      .sort();
    const used = new Set([
      ...this.usedNames,
      ...allIdentifierNames(nodes),
    ]);
    let result = nodes;

    if (conflicts.length > 0) {
      const renames = new Map<string, string>();

      for (const name of conflicts) {
        renames.set(name, freshIdentifierName(name, used));
      }

      result = renameIdentifiers(nodes, renames);
    }

    for (const name of collectLocalBindingNames(result)) {
      this.occupiedNames.add(name);
    }

    for (const name of allIdentifierNames(result)) {
      this.usedNames.add(name);
    }

    return result;
  }
}

function captureAvoidanceRenames(
  fragment: ParsedFragment,
  locals: Set<string>,
  codeBindings: Map<string, CodeValue>,
  values: Map<number, CodeValue>,
): Map<string, string> {
  const introduced = new Set<string>();

  for (const value of referencedCodeValues(fragment, locals, codeBindings, values)) {
    for (const name of freeReferenceNames(value.expandedNodes ?? value.parsed.nodes)) {
      introduced.add(name);
    }
  }

  const conflicts = Array.from(introduced)
    .filter((name) => locals.has(name))
    .sort();

  if (conflicts.length === 0) {
    return new Map();
  }

  const used = allIdentifierNames(fragment.nodes);
  const renames = new Map<string, string>();

  for (const name of conflicts) {
    renames.set(name, freshIdentifierName(name, used));
  }

  return renames;
}

function referencedCodeValues(
  fragment: ParsedFragment,
  locals: Set<string>,
  codeBindings: Map<string, CodeValue>,
  values: Map<number, CodeValue>,
): Set<CodeValue> {
  const referenced = new Set<CodeValue>();

  for (const hole of fragment.quote.holes) {
    const value = codeValueForExpression(hole.expression, codeBindings, values);

    if (value) {
      referenced.add(value);
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const binding = codeBindings.get(node.text);

      if (
        binding &&
        binding.quote.id !== fragment.quote.id &&
        codeBindingMatchesExpressionPosition(binding.kind) &&
        !locals.has(node.text) &&
        isReferenceIdentifier(node)
      ) {
        referenced.add(binding);
      }
    }

    ts.forEachChild(node, visit);
  };

  for (const node of fragment.nodes) {
    visit(node);
  }

  return referenced;
}

function codeBindingMatchesExpressionPosition(kind: CodeValue["kind"]): boolean {
  return kind === "expr" || kind === "ident";
}

export function allIdentifierNames(nodes: ts.Node[]): Set<string> {
  const names = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }

    ts.forEachChild(node, visit);
  };

  for (const node of nodes) {
    visit(node);
  }

  return names;
}

function freshIdentifierName(base: string, used: Set<string>): string {
  let suffix = 1;
  let candidate = `${base}_${suffix}`;

  while (used.has(candidate)) {
    suffix++;
    candidate = `${base}_${suffix}`;
  }

  used.add(candidate);

  return candidate;
}

export function renameIdentifiers(
  nodes: ts.Node[],
  renames: Map<string, string>,
): ts.Node[] {
  return nodes.map((node) => {
    const renamed = transformNode(node, (candidate) => {
      if (
        ts.isIdentifier(candidate) &&
        shouldRenameIdentifier(candidate, renames)
      ) {
        return completedReplacement(
          copyNodeOrigin(
            ts.factory.createIdentifier(renames.get(candidate.text)!),
            candidate,
          ),
        );
      }

      return candidate;
    });

    return Array.isArray(renamed) ? renamed[0] ?? node : renamed;
  });
}

function shouldRenameIdentifier(
  node: ts.Identifier,
  renames: Map<string, string>,
): boolean {
  return (
    renames.has(node.text) &&
    (isReferenceIdentifier(node) || isBindingIdentifier(node))
  );
}

function isBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (!parent) {
    return false;
  }

  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionExpression(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isClassExpression(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isNamespaceImport(parent) && parent.name === node) ||
    (ts.isTypeParameterDeclaration(parent) && parent.name === node)
  );
}

type Replacement = ts.VisitResult<ts.Node> | {
  node: ts.Node;
  skipChildren: true;
};

function transformNode(
  node: ts.Node,
  replace: (node: ts.Node) => Replacement,
): ts.VisitResult<ts.Node> {
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (candidate: ts.Node): ts.VisitResult<ts.Node> => {
        const replaced = replace(candidate);

        if (isCompletedReplacement(replaced)) {
          return replaced.node;
        }

        if (!replaced) {
          return candidate;
        }

        if (isNodeArrayResult(replaced)) {
          return replaced;
        }

        return copyNodeOrigin(ts.visitEachChild(replaced, visit, context), replaced);
      };

      return (root) => ts.visitNode(root, visit) ?? root;
    },
  ]);
  const result = transformed.transformed[0] ?? node;

  transformed.dispose();

  return synthesizeNode(result);
}

function completedReplacement(node: ts.Node): Replacement {
  return {node, skipChildren: true};
}

function isCompletedReplacement(
  value: Replacement,
): value is {node: ts.Node; skipChildren: true} {
  return Boolean(
    value &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      "skipChildren" in value,
  );
}

function isNodeArrayResult(
  value: ts.VisitResult<ts.Node>,
): value is readonly ts.Node[] {
  return Array.isArray(value);
}

function synthesizeNode(node: ts.Node): ts.Node {
  const transformed = ts.transform(node, [
    (context) => {
      const visit = (candidate: ts.Node): ts.Node => {
        const cloned = cloneNode(candidate);

        ts.setTextRange(cloned, {pos: -1, end: -1});

        return ts.visitEachChild(cloned, visit, context);
      };

      return (root) => ts.visitNode(root, visit) ?? root;
    },
  ]);
  const result = transformed.transformed[0] ?? node;

  transformed.dispose();

  return result;
}

function cloneNode<T extends ts.Node>(node: T): T {
  const factory = ts.factory as typeof ts.factory & {
    cloneNode<NodeType extends ts.Node>(node: NodeType): NodeType;
  };

  return copyNodeOrigin(factory.cloneNode(node), node);
}
