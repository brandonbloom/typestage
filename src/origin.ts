/**
 * Source-origin metadata helpers for diagnostics and snapshots.
 * Generated and virtual syntax carries half-open ranges back to original
 * source files so parse and expansion errors point at user-authored code.
 */
import {LinesAndColumns} from "lines-and-columns";
import type {Origin, OriginMap} from "./types.ts";

/** Creates origin metadata for a half-open source range. */
export function originForRange(
  sourceFile: string,
  start: number,
  end: number,
): Origin {
  return {sourceFile, start, end};
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
