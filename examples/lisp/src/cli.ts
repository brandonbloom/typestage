#!/usr/bin/env bun
import {writeFile} from "node:fs/promises";
import {createInterface} from "node:readline/promises";
import {stdin as input, stdout as output} from "node:process";
import {formatGraphDiagnostics} from "typestage";
import {
  compileLispFileToTypeScript,
  compileLispSourceToTypeScript,
  formatJsonValue,
  ReplRuntime,
  type EvaluationResult,
} from "./driver.ts";

type CompileArgs = {
  inputPath?: string;
  outPath?: string;
  sourceMaps: boolean;
};

const [, , command, ...args] = process.argv;

switch (command) {
  case "compile":
    await runCompile(parseCompileArgs(args));
    break;

  case "repl":
    await runRepl();
    break;

  default:
    printUsage();
    process.exit(command ? 1 : 0);
}

async function runCompile(args: CompileArgs) {
  const result = args.inputPath && args.inputPath !== "-"
    ? await compileLispFileToTypeScript(args.inputPath, {
        sourceMaps: args.sourceMaps,
      })
    : await compileLispSourceToTypeScript(await readStdin(), {
        sourceFile: "stdin.lisp",
        sourceMaps: args.sourceMaps,
      });

  const diagnostics = `${formatGraphDiagnostics(result.graph.diagnostics).join("\n")}\n`;

  if (result.graph.diagnostics.length > 0 || !result.outputText) {
    process.stderr.write(diagnostics);
    process.exit(1);
  }

  if (args.outPath) {
    await writeFile(args.outPath, result.outputText);

    if (args.sourceMaps && result.sourceMapText) {
      await writeFile(`${args.outPath}.map`, result.sourceMapText);
    }
  } else {
    process.stdout.write(result.outputText);

    if (args.sourceMaps && result.sourceMapText) {
      process.stderr.write(result.sourceMapText);
    }
  }
}

async function runRepl() {
  const runtime = await ReplRuntime.create();
  const repl = createInterface({
    input,
    output,
    prompt: "lisp> ",
  });

  repl.prompt();

  try {
    for await (const line of repl) {
      const trimmed = line.trim();

      if (trimmed === "" || trimmed === ":quit" || trimmed === ":q") {
        if (trimmed !== "") {
          break;
        }

        repl.prompt();
        continue;
      }

      const result = await compileLispSourceToTypeScript(trimmed, {
        globals: runtime.bindingNames(),
        sourceFile: "repl.lisp",
      });

      if (result.graph.diagnostics.length > 0 || !result.outputText) {
        output.write(`${formatGraphDiagnostics(result.graph.diagnostics).join("\n")}\n`);
      } else {
        output.write("\n--- TypeScript ---\n");
        output.write(result.outputText);
        output.write("\n--- Output ---\n");
        output.write(formatEvaluation(await runtime.evaluate(result.outputText)));
      }

      repl.prompt();
    }
  } finally {
    repl.close();
    await runtime.dispose();
  }
}

function parseCompileArgs(args: string[]): CompileArgs {
  const parsed: CompileArgs = {sourceMaps: false};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    switch (arg) {
      case "--source-map":
      case "--source-maps":
        parsed.sourceMaps = true;
        break;

      case "-o":
      case "--out":
        parsed.outPath = args[index + 1];
        index++;
        break;

      default:
        if (!parsed.inputPath) {
          parsed.inputPath = arg;
        } else {
          printUsage();
          process.exit(1);
        }
    }
  }

  return parsed;
}

function printUsage() {
  process.stderr.write(`Usage:
  lisp compile [--source-map] [-o output.ts] [input.lisp|-]
  lisp repl
`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function formatEvaluation(evaluation: EvaluationResult): string {
  const lines = evaluation.logs.map((line) => `${line}\n`);

  if (evaluation.threw !== undefined) {
    lines.push(`threw ${formatThrown(evaluation.threw)}\n`);
  } else {
    lines.push(`${formatJsonValue(evaluation.result)}\n`);
  }

  lines.push("\n");

  return lines.join("");
}

function formatThrown(value: unknown): string {
  return value instanceof Error
    ? `${value.name}: ${value.message}`
    : formatJsonValue(value);
}
