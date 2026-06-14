/**
 * Local browser playground for trying TypeStage fixtures and ad hoc input.
 * Examples are read from the fixture tree at request time so the playground
 * reflects newly added cases while the Bun watcher restarts the server.
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {mkdir, mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import {compileFileGraph} from "./graph.ts";
import type {Diagnostic} from "./types.ts";

type ExampleFile = {
  fileName: string;
  source: string;
};

type OutputFile = {
  fileName: string;
  outputText: string;
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
      headers: {"content-type": "text/html; charset=utf-8"},
    }),
    "/api/examples": {
      GET() {
        return Response.json(readExamples());
      },
    },
    "/api/compile": {
      async POST(request) {
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
      },
    },
  },
  fetch() {
    return new Response("Not found", {status: 404});
  },
});

console.log(`TypeStage playground: http://localhost:${server.port}`);

function readExamples(): Example[] {
  return [
    ...readExampleGroup("pass", "Pass"),
    ...readExampleGroup("fail", "Fail"),
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
    sourceRoot,
  });
  const sourceByFileName = new Map(files.map((file) => [file.fileName, file.source]));

  return {
    diagnostics: formatGraphDiagnostics(sourceRoot, sourceByFileName, result.diagnostics),
    outputFiles: result.files.map((file) => ({
      fileName: file.outputPath,
      outputText: file.outputText,
    })),
    outputText: result.files.find((file) => file.outputPath === entryFileName)?.outputText ?? "",
  };
}

function formatGraphDiagnostics(
  sourceRoot: string,
  sourceByFileName: Map<string, string>,
  diagnostics: Diagnostic[],
): string {
  if (diagnostics.length === 0) {
    return "No diagnostics.";
  }

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
    })
    .join("\n");
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
      --code-bg: #101317;
      --code-ink: #f1f5f9;
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
      grid-template-rows: auto minmax(0, 1fr) auto;
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

    .source-pane {
      grid-template-rows: auto auto minmax(0, 1fr);
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

    .diagnostics {
      min-height: 92px;
      max-height: 28vh;
      overflow: auto;
      padding: 10px 14px 14px;
      border-top: 1px solid var(--line);
      background: var(--ok-bg);
      border-color: var(--ok-border);
    }

    .diagnostics.has-errors {
      background: var(--bad-bg);
      border-color: var(--bad-border);
    }

    .diagnostics-title {
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
    }

    #diagnosticsText {
      margin: 0;
      color: var(--ink);
      background: transparent;
      padding: 0;
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
      <button id="compile" type="button">Compile</button>
    </header>
    <section class="workspace">
      <section class="pane source-pane">
        <div class="pane-header">
          <span>Source</span>
        </div>
        <div id="sourceTabs" class="file-tabs" role="tablist" aria-label="Source files"></div>
        <textarea id="source" spellcheck="false"></textarea>
      </section>
      <section class="pane">
        <div class="pane-header">
          <span>Compiled Output</span>
        </div>
        <pre id="output"></pre>
      </section>
    </section>
    <footer id="diagnostics" class="diagnostics">
      <p class="diagnostics-title">Diagnostics</p>
      <pre id="diagnosticsText">Loading examples...</pre>
    </footer>
  </main>
  <script type="module">
    const examplesSelect = document.querySelector("#examples");
    const source = document.querySelector("#source");
    const sourceTabs = document.querySelector("#sourceTabs");
    const output = document.querySelector("#output");
    const diagnostics = document.querySelector("#diagnostics");
    const diagnosticsText = document.querySelector("#diagnosticsText");
    const compileButton = document.querySelector("#compile");
    let examples = [];
    let selectedExample;
    let currentFileName = "";
    let lastCompileResult;
    let debounceTimer;
    let loadingExample = false;

    boot();

    async function boot() {
      examples = await fetchJson("/api/examples");
      populateExamples(examples);
      selectedExample = exampleFromLocation() ?? examples[0];

      if (selectedExample) {
        loadExample(selectedExample.id, {updateUrl: false});
      } else {
        diagnosticsText.textContent = "No fixtures found.";
      }

      examplesSelect.addEventListener("change", () => loadExample(examplesSelect.value));
      compileButton.addEventListener("click", compileNow);
      source.addEventListener("input", () => {
        saveCurrentSource();

        if (!loadingExample) {
          clearExampleParam();
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(compileNow, 250);
      });
    }

    function exampleFromLocation() {
      const id = new URL(location.href).searchParams.get("example");

      return id ? examples.find((example) => example.id === id) : undefined;
    }

    function populateExamples(items) {
      examplesSelect.textContent = "";
      const groups = new Map();

      for (const item of items) {
        const groupItems = groups.get(item.group) ?? [];

        groupItems.push(item);
        groups.set(item.group, groupItems);
      }

      for (const [groupName, groupItems] of groups) {
        const group = document.createElement("optgroup");
        group.label = groupName;

        for (const item of groupItems) {
          const option = document.createElement("option");
          option.value = item.id;
          option.textContent = item.name;
          group.append(option);
        }

        examplesSelect.append(group);
      }
    }

    function loadExample(id, options = {}) {
      selectedExample = examples.find((example) => example.id === id);

      if (!selectedExample) {
        return;
      }

      loadingExample = true;
      examplesSelect.value = selectedExample.id;
      currentFileName = selectedExample.entryFileName;
      renderSourceTabs();
      loadCurrentSource();
      lastCompileResult = {
        outputFiles: selectedExample.outputFiles,
        outputText: selectedExample.outputFiles.find((file) => file.fileName === currentFileName)?.outputText ?? "",
      };
      renderOutput();
      loadingExample = false;

      if (options.updateUrl ?? true) {
        setExampleParam(selectedExample.id);
      }

      compileNow();
    }

    function renderSourceTabs() {
      sourceTabs.textContent = "";

      for (const file of currentFiles()) {
        const tab = document.createElement("button");

        tab.type = "button";
        tab.className = "file-tab";
        tab.textContent = file.fileName;
        tab.dataset.fileName = file.fileName;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(file.fileName === currentFileName));
        tab.classList.toggle("is-active", file.fileName === currentFileName);
        tab.addEventListener("click", () => selectSourceFile(file.fileName));
        sourceTabs.append(tab);
      }
    }

    function selectSourceFile(fileName) {
      if (fileName === currentFileName) {
        return;
      }

      saveCurrentSource();
      currentFileName = fileName;
      renderSourceTabs();
      loadCurrentSource();
      renderOutput();
    }

    function currentFiles() {
      return selectedExample?.files ?? [
        {
          fileName: "main.ts",
          source: source.value,
        },
      ];
    }

    function currentFile() {
      return currentFiles().find((file) => file.fileName === currentFileName);
    }

    function loadCurrentSource() {
      const file = currentFile();

      source.value = file?.source ?? "";
    }

    function saveCurrentSource() {
      const file = currentFile();

      if (file) {
        file.source = source.value;
      }
    }

    function setExampleParam(id) {
      const url = new URL(location.href);

      url.searchParams.set("example", id);
      history.replaceState(null, "", url);
    }

    function clearExampleParam() {
      const url = new URL(location.href);

      if (!url.searchParams.has("example")) {
        return;
      }

      url.searchParams.delete("example");
      history.replaceState(null, "", url);
    }

    async function compileNow() {
      saveCurrentSource();

      try {
        const result = await fetchJson("/api/compile", compileRequest());

        lastCompileResult = result;
        renderOutput();
        diagnosticsText.textContent = result.diagnostics;
        diagnostics.classList.toggle("has-errors", result.diagnostics !== "No diagnostics.");
      } catch (error) {
        output.textContent = "";
        diagnosticsText.textContent = error instanceof Error ? error.message : String(error);
        diagnostics.classList.add("has-errors");
      }
    }

    function compileRequest() {
      return {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          entryFileName: selectedExample?.entryFileName ?? "main.ts",
          files: currentFiles(),
        }),
      };
    }

    function renderOutput() {
      const outputFiles = lastCompileResult?.outputFiles ?? selectedExample?.outputFiles ?? [];
      const matchingOutput = outputFiles.find((file) => file.fileName === currentFileName);

      output.textContent = matchingOutput?.outputText ?? lastCompileResult?.outputText ?? "";
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);

      if (!response.ok) {
        throw new Error(await response.text());
      }

      return response.json();
    }
  </script>
</body>
</html>`;
}
