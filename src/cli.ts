#!/usr/bin/env bun
import {emitFile} from "./compiler.ts";
import {formatOrigin} from "./origin.ts";

const [, , inputPath, outputPath] = Bun.argv;

if (!inputPath) {
  console.error("usage: typestage <input.ts> [output.ts]");
  process.exit(2);
}

const sourceText = await Bun.file(inputPath).text();
const result = await emitFile(inputPath, outputPath);

if (result.diagnostics.length > 0) {
  for (const diagnostic of result.diagnostics) {
    const origin = diagnostic.origin
      ? `${formatOrigin(sourceText, diagnostic.origin)} - `
      : "";
    console.error(`${origin}${diagnostic.code}: ${diagnostic.message}`);
  }

  process.exit(1);
}

if (!outputPath) {
  console.log(result.outputText);
}
