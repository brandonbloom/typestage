/**
 * Source-origin metadata helpers for diagnostics and snapshots.
 * Generated and virtual syntax carries half-open ranges back to original
 * source files so parse and expansion errors point at user-authored code.
 */
import {LinesAndColumns} from "lines-and-columns";
import * as ts from "typescript";
import type {Origin, OriginMap} from "./types.ts";

const nodeOrigins = new WeakMap<ts.Node, Origin>();

/** Creates origin metadata for a half-open source range. */
export function originForRange(
  sourceFile: string,
  start: number,
  end: number,
): Origin {
  return {sourceFile, start, end};
}

/** Associates a generated TypeScript AST node with original source text. */
export function setNodeOrigin<T extends ts.Node>(node: T, origin: Origin): T {
  nodeOrigins.set(node, origin);

  return node;
}

/** Returns original source metadata previously associated with an AST node. */
export function getNodeOrigin(node: ts.Node): Origin | undefined {
  return nodeOrigins.get(node);
}

/** Copies original source metadata between related AST nodes. */
export function copyNodeOrigin<T extends ts.Node>(target: T, source: ts.Node): T {
  const origin = getNodeOrigin(source);

  return origin ? setNodeOrigin(target, origin) : target;
}

/** Associates every node in an AST subtree with the same original source range. */
export function setTreeOrigin<T extends ts.Node>(node: T, origin: Origin): T {
  const visit = (candidate: ts.Node) => {
    setNodeOrigin(candidate, origin);
    ts.forEachChild(candidate, visit);
  };

  visit(node);

  return node;
}

/** Creates per-character origin metadata for text copied from source. */
export function originMapForText(
  sourceFile: string,
  start: number,
  text: string,
): OriginMap {
  return Array.from({length: text.length}, (_, index) =>
    originForRange(sourceFile, start + index, start + index + 1),
  );
}

/** Formats an origin as a one-based file, line, and column location. */
export function formatOrigin(sourceText: string, origin: Origin): string {
  const lines = new LinesAndColumns(sourceText);
  const location = lines.locationForIndex(origin.start);

  if (!location) {
    return `${origin.sourceFile}:0:0`;
  }

  return `${origin.sourceFile}:${location.line + 1}:${location.column + 1}`;
}

/** Converts origin metadata into source offsets for compact snapshots. */
export function compactOriginMap(originMap: OriginMap): Array<number | null> {
  return originMap.map((origin) => origin?.start ?? null);
}
