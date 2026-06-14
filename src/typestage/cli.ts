#!/usr/bin/env bun
/**
 * Command-line entrypoint for TypeStage compilation.
 * The CLI compiles a local module graph and writes one residual file per
 * source module under the requested output directory.
 */
import {emitFileGraph, formatGraphDiagnostics} from "./nodejs.ts";

const [, , inputPath, outDir] = Bun.argv;

if (!inputPath || !outDir) {
  console.error("usage: typestage <entry.ts> <outdir>");
  process.exit(2);
}

const result = await emitFileGraph(inputPath, outDir);

if (result.diagnostics.length > 0) {
  for (const line of formatGraphDiagnostics(result.diagnostics)) {
    console.error(line);
  }

  process.exit(1);
}
