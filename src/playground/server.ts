/**
 * Local browser playground for trying TypeStage fixtures and ad hoc input.
 * Examples are read from the fixture tree at request time so the playground
 * reflects newly added cases while the Bun watcher restarts the server.
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, join, relative, resolve} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import {compileFileGraph, originalPositionForGeneratedLocation} from "typestage";
import type {CompileGraphFile, Diagnostic} from "typestage";

type ExampleFile = {
  fileName: string;
  source: string;
};

type OutputFile = {
  fileName: string;
  outputText: string;
};

type PlaygroundDiagnostic = {
  code: string;
  fileName: string;
  from: number;
  message: string;
  severity: "error";
  to: number;
};

type Example = {
  entryFileName: string;
  files: ExampleFile[];
  id: string;
  group: string;
  name: string;
  outputFiles: OutputFile[];
};

const fixturesRoot = join(process.cwd(), "tests", "fixtures");
const port = Number(Bun.env.PORT ?? 3000);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/": new Response(pageHtml(), {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    }),
    "/api/examples": {
      GET() {
        return Response.json(readExamples());
      },
    },
    "/playground-client.js": {
      async GET() {
        return playgroundClientResponse();
      },
    },
    "/api/compile": {
      async POST(request) {
        try {
          const body = (await request.json()) as {
            entryFileName?: string;
            files?: ExampleFile[];
          };
          const files = body.files?.length
            ? body.files
            : [{fileName: "main.ts", source: ""}];
          const result = await compilePlaygroundGraph(
            files,
            body.entryFileName ?? files[0]?.fileName ?? "main.ts",
          );

          return Response.json(result);
        } catch (error) {
          return Response.json(playgroundErrorResult(error));
        }
      },
    },
  },
  fetch() {
    return new Response("Not found", {status: 404});
  },
});

console.log(`TypeStage playground: http://localhost:${server.port}`);

function playgroundErrorResult(error: unknown) {
  return {
    diagnostics: `Internal Error: ${errorMessage(error)}`,
    outputFiles: [],
    outputText: "",
    sourceDiagnostics: [],
  };
}

function readExamples(): Example[] {
  return [
    ...readExampleGroup("pass", "Pass"),
    ...readExampleGroup("fail", "Fail"),
    ...readExampleGroup("typecheck", "Typecheck"),
  ];
}

function readExampleGroup(directoryName: string, group: string): Example[] {
  const directory = join(fixturesRoot, directoryName);

  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, {withFileTypes: true})
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(directory, entry.name, "input", "main.ts")))
    .map((entry) => {
      const caseRoot = join(directory, entry.name);
      const inputRoot = join(caseRoot, "input");

      return {
        entryFileName: "main.ts",
        files: readFixtureTree(inputRoot).map((file) => ({
          fileName: file.fileName,
          source: file.text,
        })),
        id: `${directoryName}/${entry.name}`,
        group,
        name: entry.name,
        outputFiles: readFixtureTree(join(caseRoot, "output")).map((file) => ({
          fileName: file.fileName,
          outputText: file.text,
        })),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readFixtureTree(root: string, prefix = ""): Array<{
  fileName: string;
  text: string;
}> {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, {withFileTypes: true})
    .flatMap((entry) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(root, entry.name);

      return entry.isDirectory()
        ? readFixtureTree(path, name)
        : [{fileName: name, text: readFileSync(path, "utf8")}];
    })
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

async function compilePlaygroundGraph(files: ExampleFile[], entryFileName: string) {
  const sourceRoot = await mkdtemp(join(tmpdir(), "typestage-playground-"));

  for (const file of files) {
    const filePath = join(sourceRoot, file.fileName);

    await mkdir(dirname(filePath), {recursive: true});
    await Bun.write(filePath, file.source);
  }

  const result = await compileFileGraph(join(sourceRoot, entryFileName), {
    sourceMaps: true,
    sourceRoot,
  });
  const sourceByFileName = new Map(files.map((file) => [file.fileName, file.source]));
  const graphDiagnostics = playgroundSourceDiagnostics(sourceRoot, result.diagnostics);
  const typecheck = result.diagnostics.length === 0
    ? await typecheckPlaygroundOutput(sourceRoot, sourceByFileName, result.files)
    : {diagnostics: [], textLines: []};
  const diagnosticLines = [
    ...formatGraphDiagnosticLines(sourceRoot, sourceByFileName, result.diagnostics),
    ...typecheck.textLines,
  ];

  return {
    diagnostics: diagnosticLines.length > 0 ? diagnosticLines.join("\n") : "No diagnostics.",
    outputFiles: result.files.flatMap((file) => [
      {
        fileName: file.outputPath,
        outputText: file.outputText,
      },
      ...(file.sourceMapPath && file.sourceMapText
        ? [{
            fileName: file.sourceMapPath,
            outputText: file.sourceMapText,
          }]
        : []),
    ]),
    outputText: result.files.find((file) => file.outputPath === entryFileName)?.outputText ?? "",
    sourceDiagnostics: [
      ...graphDiagnostics,
      ...typecheck.diagnostics,
    ],
  };
}

async function playgroundClientResponse(): Promise<Response> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "client.ts")],
    format: "esm",
    target: "browser",
  });

  if (!result.success) {
    return new Response(result.logs.map((log) => log.message).join("\n"), {status: 500});
  }

  return new Response(await result.outputs[0]!.text(), {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
    },
  });
}

function formatGraphDiagnosticLines(
  sourceRoot: string,
  sourceByFileName: Map<string, string>,
  diagnostics: Diagnostic[],
): string[] {
  return diagnostics
    .map((diagnostic) => {
      if (!diagnostic.origin) {
        return `${diagnostic.code}: ${diagnostic.message}`;
      }

      const absoluteSourceFile = resolve(process.cwd(), diagnostic.origin.sourceFile);
      const fileName = relative(sourceRoot, absoluteSourceFile);
      const sourceText = sourceByFileName.get(fileName) ?? "";
      const lines = new LinesAndColumns(sourceText);
      const location = lines.locationForIndex(diagnostic.origin.start);
      const line = location ? location.line + 1 : 0;
      const column = location ? location.column + 1 : 0;

      return `${fileName}:${line}:${column} ${diagnostic.code}: ${diagnostic.message}`;
    });
}

function playgroundSourceDiagnostics(
  sourceRoot: string,
  diagnostics: Diagnostic[],
): PlaygroundDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnostic.origin) {
      return [];
    }

    const absoluteSourceFile = resolve(process.cwd(), diagnostic.origin.sourceFile);

    return [{
      code: diagnostic.code,
      fileName: relative(sourceRoot, absoluteSourceFile),
      from: diagnostic.origin.start,
      message: diagnostic.message,
      severity: "error" as const,
      to: diagnostic.origin.end,
    }];
  });
}

async function typecheckPlaygroundOutput(
  sourceRoot: string,
  sourceByFileName: Map<string, string>,
  files: CompileGraphFile[],
): Promise<{
  diagnostics: PlaygroundDiagnostic[];
  textLines: string[];
}> {
  const outputRoot = await mkdtemp(join(tmpdir(), "typestage-playground-typecheck-"));

  try {
    const sourceMapsByOutputPath = new Map<string, string>();

    for (const file of files) {
      const outputPath = join(outputRoot, file.outputPath);

      await mkdir(dirname(outputPath), {recursive: true});
      await Bun.write(outputPath, file.outputText);

      if (file.sourceMapPath && file.sourceMapText) {
        const sourceMapPath = join(outputRoot, file.sourceMapPath);

        await mkdir(dirname(sourceMapPath), {recursive: true});
        await Bun.write(sourceMapPath, file.sourceMapText);
        sourceMapsByOutputPath.set(resolve(outputPath), file.sourceMapText);
        sourceMapsByOutputPath.set(outputPath, file.sourceMapText);
        sourceMapsByOutputPath.set(file.outputPath, file.sourceMapText);
        sourceMapsByOutputPath.set(basename(file.outputPath), file.sourceMapText);
      }
    }

    await Bun.write(
      join(outputRoot, "tsconfig.json"),
      `${JSON.stringify({
        compilerOptions: {
          lib: ["ES2024"],
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          strict: true,
          target: "ES2024",
        },
        include: ["**/*.ts"],
      }, null, 2)}\n`,
    );

    const child = Bun.spawn(
      [
        join(process.cwd(), "node_modules", ".bin", "tsgo"),
        "--pretty",
        "false",
        "-p",
        join(outputRoot, "tsconfig.json"),
      ],
      {
        cwd: outputRoot,
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = `${stdout}${stderr}`.trim();

    if (!output) {
      if (status !== 0) {
        throw new Error(`tsgo exited with status ${status} and no diagnostics`);
      }

      return {diagnostics: [], textLines: []};
    }

    return output.split("\n").reduce<{
      diagnostics: PlaygroundDiagnostic[];
      textLines: string[];
    }>((summary, line) => {
      const diagnostic = remapTypecheckDiagnostic(
        line,
        outputRoot,
        sourceRoot,
        sourceByFileName,
        sourceMapsByOutputPath,
      );

      summary.textLines.push(diagnostic.textLine);

      if (diagnostic.sourceDiagnostic) {
        summary.diagnostics.push(diagnostic.sourceDiagnostic);
      }

      return summary;
    }, {diagnostics: [], textLines: []});
  } finally {
    await rm(outputRoot, {force: true, recursive: true});
  }
}

function remapTypecheckDiagnostic(
  line: string,
  outputRoot: string,
  sourceRoot: string,
  sourceByFileName: Map<string, string>,
  sourceMapsByOutputPath: Map<string, string>,
): {
  sourceDiagnostic?: PlaygroundDiagnostic;
  textLine: string;
} {
  const match = /^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);

  if (!match) {
    return {textLine: line};
  }

  const [, generatedFile, lineText, columnText, code, message] = match;
  const diagnosticCode = code ?? "0000";
  const diagnosticMessage = message ?? "";
  const generatedPath = resolve(outputRoot, generatedFile!);
  const sourceMapText =
    sourceMapsByOutputPath.get(generatedPath) ??
    sourceMapsByOutputPath.get(relative(outputRoot, generatedPath)) ??
    sourceMapsByOutputPath.get(generatedFile!) ??
    sourceMapsByOutputPath.get(basename(generatedFile!));
  const original = sourceMapText
    ? originalPositionForGeneratedLocation(
        sourceMapText,
        Number(lineText),
        Number(columnText),
      )
    : undefined;

  if (!original) {
    return {
      textLine: `${generatedFile}:${lineText}:${columnText} TS${diagnosticCode}: ${diagnosticMessage}`,
    };
  }

  const absoluteSourceFile = resolve(process.cwd(), original.sourceFile);
  const fileName = relative(sourceRoot, absoluteSourceFile);
  const sourceText = sourceByFileName.get(fileName) ?? "";
  const index = new LinesAndColumns(sourceText).indexForLocation({
    column: original.column - 1,
    line: original.line - 1,
  });
  const from = index ?? 0;
  const to = diagnosticEnd(sourceText, from);

  return {
    sourceDiagnostic: {
      code: `TS${diagnosticCode}`,
      fileName,
      from,
      message: diagnosticMessage,
      severity: "error",
      to,
    },
    textLine: `${fileName}:${original.line}:${original.column} TS${diagnosticCode}: ${diagnosticMessage}`,
  };
}

function diagnosticEnd(sourceText: string, start: number): number {
  let end = start;

  while (end < sourceText.length && /[$\w]/u.test(sourceText[end]!)) {
    end++;
  }

  return end > start ? end : Math.min(sourceText.length, start + 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TypeStage Playground</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #15171a;
      --muted: #5f6876;
      --line: #d9dee7;
      --accent: #176b87;
      --accent-strong: #0f4f64;
      --bad-bg: #fff1f1;
      --bad-border: #e5aaaa;
      --ok-bg: #eef9f2;
      --ok-border: #a8d7b8;
      --code-bg: #ffffff;
      --code-ink: #15171a;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .shell {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 100vh;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }

    .brand {
      font-weight: 700;
      margin-right: auto;
    }

    label {
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }

    select,
    button {
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font: inherit;
    }

    select {
      width: min(360px, 45vw);
      padding: 0 34px 0 10px;
    }

    button {
      padding: 0 14px;
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
      font-weight: 650;
      cursor: pointer;
    }

    button:hover {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1px;
      min-height: 0;
      background: var(--line);
    }

    .pane {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      background: var(--panel);
    }

    .source-pane,
    .output-pane {
      grid-template-rows: auto auto minmax(0, 1fr) auto;
    }

    .pane-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 38px;
      padding: 0 12px;
      border-bottom: 1px solid var(--line);
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }

    .file-tabs {
      display: flex;
      min-height: 37px;
      overflow-x: auto;
      border-bottom: 1px solid var(--line);
      background: #fbfcfd;
    }

    .file-tab {
      min-width: 0;
      min-height: 36px;
      padding: 0 12px;
      border: 0;
      border-right: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
      white-space: nowrap;
    }

    .file-tab:hover,
    .file-tab.is-active {
      background: #eef3f7;
      color: var(--ink);
    }

    textarea,
    pre {
      width: 100%;
      height: 100%;
      min-height: 0;
      margin: 0;
      padding: 14px;
      border: 0;
      outline: none;
      resize: none;
      overflow: auto;
      background: var(--code-bg);
      color: var(--code-ink);
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      tab-size: 2;
      white-space: pre;
    }

    .editor-host {
      width: 100%;
      height: 100%;
      min-height: 0;
      overflow: hidden;
      background: var(--code-bg);
    }

    .details-panel {
      position: relative;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      min-height: 92px;
      max-height: 28vh;
      overflow: hidden;
      padding: 10px 14px 14px;
      border-top: 1px solid var(--line);
    }

    .diagnostics {
      background: var(--ok-bg);
      border-color: var(--ok-border);
    }

    .diagnostics.has-errors {
      background: var(--bad-bg);
      border-color: var(--bad-border);
    }

    .mapping-info {
      background: #f8fafc;
    }

    .details-title {
      margin: 0 34px 6px 0;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }

    .copy-button {
      position: absolute;
      top: 8px;
      right: 8px;
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      min-height: 0;
      padding: 0;
      opacity: 0;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.92);
      color: var(--muted);
      cursor: pointer;
      transition: opacity 120ms ease, color 120ms ease, border-color 120ms ease;
    }

    .details-panel:hover .copy-button,
    .details-panel:focus-within .copy-button {
      opacity: 1;
    }

    .copy-button:hover,
    .copy-button:focus-visible {
      border-color: var(--accent);
      color: var(--accent);
      outline: none;
    }

    .copy-button svg {
      width: 15px;
      height: 15px;
    }

    #diagnosticsText,
    #outputSelectionText {
      margin: 0;
      color: var(--ink);
      background: transparent;
      padding: 0;
      overflow: auto;
      white-space: pre-wrap;
    }

    @media (max-width: 760px) {
      .toolbar {
        align-items: stretch;
        flex-wrap: wrap;
      }

      .brand {
        width: 100%;
      }

      select {
        width: 100%;
      }

      .workspace {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(320px, 1fr) minmax(260px, 0.8fr);
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="toolbar">
      <div class="brand">TypeStage Playground</div>
      <label for="examples">Example</label>
      <select id="examples"></select>
    </header>
    <section class="workspace">
      <section class="pane source-pane">
        <div class="pane-header">
          <span>Source</span>
        </div>
        <div id="sourceTabs" class="file-tabs" role="tablist" aria-label="Source files"></div>
        <div id="source" class="editor-host"></div>
        <footer id="diagnostics" class="details-panel diagnostics">
          <p class="details-title">Diagnostics</p>
          <button class="copy-button" type="button" data-copy-target="diagnosticsText" aria-label="Copy diagnostics" title="Copy diagnostics">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="8" y="8" width="12" height="12" rx="2"></rect>
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
            </svg>
          </button>
          <pre id="diagnosticsText">Loading examples...</pre>
        </footer>
      </section>
      <section class="pane output-pane">
        <div class="pane-header">
          <span>Compiled Output</span>
        </div>
        <div id="outputTabs" class="file-tabs" role="tablist" aria-label="Output files"></div>
        <div id="output" class="editor-host"></div>
        <footer id="outputSelection" class="details-panel mapping-info">
          <p class="details-title">Output Selection</p>
          <button class="copy-button" type="button" data-copy-target="outputSelectionText" aria-label="Copy output selection" title="Copy output selection">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="8" y="8" width="12" height="12" rx="2"></rect>
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path>
            </svg>
          </button>
          <pre id="outputSelectionText">No output selected.</pre>
        </footer>
      </section>
    </section>
  </main>
  <script type="module" src="/playground-client.js"></script>
</body>
</html>`;
}
