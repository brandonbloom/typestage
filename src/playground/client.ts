/// <reference lib="dom" />
/**
 * Browser client for the TypeStage playground.
 * This module owns CodeMirror editor setup, tab synchronization, debounced
 * compilation, and rendering compiler diagnostics as source editor squiggles.
 */
import {history as codeMirrorHistory, historyKeymap, indentWithTab, defaultKeymap} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import {json} from "@codemirror/lang-json";
import {javascript} from "@codemirror/lang-javascript";
import {type Diagnostic as CodeMirrorDiagnostic, lintGutter, lintKeymap, setDiagnostics} from "@codemirror/lint";
import {Compartment, EditorState} from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  ViewPlugin,
  type KeyBinding,
} from "@codemirror/view";

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

type PlaygroundDiagnostic = {
  code: string;
  fileName: string;
  from: number;
  message: string;
  severity: "error";
  to: number;
};

type CompileResult = {
  diagnostics: string;
  outputFiles: OutputFile[];
  outputText: string;
  sourceDiagnostics: PlaygroundDiagnostic[];
};

type SourceMapMapping = {
  generatedColumn: number;
  generatedLine: number;
  sourceColumn: number;
  sourceFile: string;
  sourceLine: number;
};

type SourceMapLookup = {
  mappings: SourceMapMapping[];
  sources: string[];
};

const examplesSelect = query<HTMLSelectElement>("#examples");
const sourceElement = query<HTMLElement>("#source");
const sourceTabs = query<HTMLElement>("#sourceTabs");
const outputTabs = query<HTMLElement>("#outputTabs");
const outputElement = query<HTMLElement>("#output");
const diagnostics = query<HTMLElement>("#diagnostics");
const diagnosticsText = query<HTMLElement>("#diagnosticsText");
const sourceLanguage = new Compartment();
const outputLanguage = new Compartment();
const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Values = new Map(Array.from(base64Digits, (digit, index) => [digit, index]));
let examples: Example[] = [];
let selectedExample: Example | undefined;
let currentFileName = "";
let currentOutputFileName = "";
let lastCompileResult: CompileResult | undefined;
let sourceDiagnostics: PlaygroundDiagnostic[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let loadingExample = false;
let replacingDocument = false;

const sourceView = new EditorView({
  parent: sourceElement,
  state: EditorState.create({
    extensions: [
      ...editorExtensions(),
      sourceLanguage.of(javascript({typescript: true})),
      lintGutter(),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || replacingDocument) {
          return;
        }

        saveCurrentSource();

        if (!loadingExample) {
          clearExampleParam();
        }

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(compileNow, 250);
      }),
    ],
  }),
});

const outputView = new EditorView({
  parent: outputElement,
  state: EditorState.create({
    extensions: [
      ...editorExtensions(),
      outputLanguage.of(languageForOutputFile("main.ts")),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      outputSourceMapClickHandler(),
    ],
  }),
});

void boot();

async function boot() {
  examples = await fetchJson<Example[]>("/api/examples");
  populateExamples(examples);
  selectedExample = exampleFromLocation() ?? examples[0];

  if (selectedExample) {
    loadExample(selectedExample.id, {updateUrl: false});
  } else {
    diagnosticsText.textContent = "No fixtures found.";
  }

  examplesSelect.addEventListener("change", () => loadExample(examplesSelect.value));
  document.addEventListener("keydown", handleExampleHotkey);
}

function query<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);

  if (!element) {
    throw new Error(`missing playground element '${selector}'`);
  }

  return element;
}

function editorExtensions() {
  return defined([
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    codeMirrorHistory(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    editorTheme,
    keymap.of(defined<KeyBinding>([
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...lintKeymap,
    ])),
  ]);
}

function defined<Value>(values: Array<Value | undefined>): Value[] {
  return values.filter((value): value is Value => value !== undefined);
}

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--code-bg)",
    color: "var(--code-ink)",
    fontSize: "13px",
    height: "100%",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    lineHeight: "1.5",
    minHeight: "100%",
    padding: "14px 0",
  },
  ".cm-editor": {
    height: "100%",
  },
  ".cm-gutters": {
    backgroundColor: "var(--code-bg)",
    borderRight: "1px solid var(--line)",
    color: "var(--muted)",
  },
  ".cm-line": {
    padding: "0 14px 0 8px",
  },
  ".cm-scroller": {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    overflow: "auto",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#cfe4f2",
  },
  ".cm-tooltip": {
    border: "1px solid var(--line)",
    borderRadius: "4px",
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.18)",
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  ".cm-tooltip-lint": {
    backgroundColor: "#fff8f8",
    color: "var(--ink)",
  },
  ".cm-diagnostic-error": {
    borderLeftColor: "#bd2b2b",
  },
  ".cm-lintRange-error": {
    backgroundImage:
      "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"6\" height=\"3\"><path d=\"M0 2.5 Q1.5 0 3 2.5 T6 2.5\" fill=\"none\" stroke=\"%23e04747\" stroke-width=\"1.1\"/></svg>')",
    backgroundPosition: "left bottom",
    backgroundRepeat: "repeat-x",
    paddingBottom: "2px",
  },
});

function languageForOutputFile(fileName: string) {
  return fileName.endsWith(".map") ? json() : javascript({typescript: true});
}

function outputSourceMapClickHandler() {
  return ViewPlugin.define(() => ({}), {
    eventHandlers: {
      click(event, view) {
        const position = view.posAtCoords({
          x: event.clientX,
          y: event.clientY,
        });

        if (position === null) {
          return false;
        }

        const line = view.state.doc.lineAt(position);
        const column = position - line.from + 1;

        return navigateToSourceMapLocation(line.number, column);
      },
    },
  });
}

function exampleFromLocation() {
  const id = new URL(location.href).searchParams.get("example");

  return id ? examples.find((example) => example.id === id) : undefined;
}

function populateExamples(items: Example[]) {
  examplesSelect.textContent = "";
  const groups = new Map<string, Example[]>();

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

function loadExample(id: string, options: {updateUrl?: boolean} = {}) {
  selectedExample = examples.find((example) => example.id === id);

  if (!selectedExample) {
    return;
  }

  loadingExample = true;
  examplesSelect.value = selectedExample.id;
  currentFileName = selectedExample.entryFileName;
  currentOutputFileName = selectedExample.entryFileName;
  renderSourceTabs();
  loadCurrentSource();
  sourceDiagnostics = [];
  lastCompileResult = {
    diagnostics: "No diagnostics.",
    outputFiles: selectedExample.outputFiles,
    outputText: selectedExample.outputFiles.find((file) => file.fileName === currentFileName)?.outputText ?? "",
    sourceDiagnostics: [],
  };
  synchronizeOutputFile(currentFileName);
  renderOutputTabs();
  renderOutput();
  loadingExample = false;

  if (options.updateUrl ?? true) {
    setExampleParam(selectedExample.id);
  }

  void compileNow();
}

function handleExampleHotkey(event: KeyboardEvent) {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    selectAdjacentExample(-1);
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    selectAdjacentExample(1);
  }
}

function selectAdjacentExample(delta: number) {
  if (!selectedExample || examples.length === 0) {
    return;
  }

  const currentIndex = examples.findIndex((example) => example.id === selectedExample?.id);
  const nextIndex = (Math.max(0, currentIndex) + delta + examples.length) % examples.length;
  const nextExample = examples[nextIndex];

  if (nextExample) {
    loadExample(nextExample.id);
  }
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

function renderOutputTabs() {
  outputTabs.textContent = "";

  for (const file of currentOutputFiles()) {
    const tab = document.createElement("button");

    tab.type = "button";
    tab.className = "file-tab";
    tab.textContent = file.fileName;
    tab.dataset.fileName = file.fileName;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(file.fileName === currentOutputFileName));
    tab.classList.toggle("is-active", file.fileName === currentOutputFileName);
    tab.addEventListener("click", () => selectOutputFile(file.fileName));
    outputTabs.append(tab);
  }
}

function selectSourceFile(fileName: string) {
  if (fileName === currentFileName) {
    return;
  }

  saveCurrentSource();
  currentFileName = fileName;
  synchronizeOutputFile(fileName);
  renderSourceTabs();
  loadCurrentSource();
  applySourceDiagnostics();
  renderOutputTabs();
  renderOutput();
}

function selectOutputFile(fileName: string) {
  if (fileName === currentOutputFileName) {
    return;
  }

  currentOutputFileName = fileName;

  if (currentFiles().some((file) => file.fileName === fileName)) {
    saveCurrentSource();
    currentFileName = fileName;
    renderSourceTabs();
    loadCurrentSource();
    applySourceDiagnostics();
  }

  renderOutputTabs();
  renderOutput();
}

function currentFiles(): ExampleFile[] {
  return selectedExample?.files ?? [
    {
      fileName: "main.ts",
      source: sourceText(),
    },
  ];
}

function currentFile() {
  return currentFiles().find((file) => file.fileName === currentFileName);
}

function currentOutputFiles() {
  return lastCompileResult?.outputFiles ?? selectedExample?.outputFiles ?? [];
}

function currentOutputFile() {
  return currentOutputFiles().find((file) => file.fileName === currentOutputFileName);
}

function synchronizeOutputFile(fileName: string) {
  const outputFiles = currentOutputFiles();

  currentOutputFileName =
    outputFiles.find((file) => file.fileName === fileName)?.fileName ??
    outputFiles.find((file) => !file.fileName.endsWith(".map"))?.fileName ??
    outputFiles[0]?.fileName ??
    fileName;
}

function loadCurrentSource() {
  const file = currentFile();

  replaceDocument(sourceView, file?.source ?? "");
}

function saveCurrentSource() {
  const file = currentFile();

  if (file) {
    file.source = sourceText();
  }
}

function sourceText() {
  return sourceView.state.doc.toString();
}

function setExampleParam(id: string) {
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
    const result = await fetchJson<CompileResult>("/api/compile", compileRequest());

    lastCompileResult = result;
    sourceDiagnostics = result.sourceDiagnostics;
    synchronizeOutputFile(currentFileName);
    renderOutputTabs();
    renderOutput();
    applySourceDiagnostics();
    diagnosticsText.textContent = result.diagnostics;
    diagnostics.classList.toggle("has-errors", result.diagnostics !== "No diagnostics.");
  } catch (error) {
    replaceDocument(outputView, "");
    sourceView.dispatch(setDiagnostics(sourceView.state, []));
    diagnosticsText.textContent = error instanceof Error ? error.message : String(error);
    diagnostics.classList.add("has-errors");
  }
}

function compileRequest(): RequestInit {
  return {
    body: JSON.stringify({
      entryFileName: selectedExample?.entryFileName ?? "main.ts",
      files: currentFiles(),
    }),
    headers: {"content-type": "application/json"},
    method: "POST",
  };
}

function renderOutput() {
  const outputFile = currentOutputFile();

  outputView.dispatch({
    effects: outputLanguage.reconfigure(languageForOutputFile(currentOutputFileName)),
  });
  replaceDocument(outputView, outputFile?.outputText ?? lastCompileResult?.outputText ?? "");
}

function navigateToSourceMapLocation(generatedLine: number, generatedColumn: number) {
  if (currentOutputFileName.endsWith(".map")) {
    return false;
  }

  const sourceMapText = sourceMapTextForOutput(currentOutputFileName);
  const original = sourceMapText
    ? originalPositionForGeneratedLocation(sourceMapText, generatedLine, generatedColumn)
    : undefined;

  if (!original) {
    return false;
  }

  const fileName = sourceFileNameForTab(original.sourceFile);

  if (!currentFiles().some((file) => file.fileName === fileName)) {
    return false;
  }

  saveCurrentSource();
  currentFileName = fileName;
  renderSourceTabs();
  loadCurrentSource();
  applySourceDiagnostics();

  const position = positionForLineAndColumn(
    sourceView.state,
    original.line,
    original.column,
  );
  const selection = tokenSelectionAround(sourceView.state, position);

  sourceView.dispatch({
    effects: EditorView.scrollIntoView(selection.from, {y: "center"}),
    selection: {
      anchor: selection.from,
      head: selection.to,
    },
  });
  sourceView.focus();

  return true;
}

function sourceMapTextForOutput(fileName: string): string | undefined {
  return currentOutputFiles().find((file) => file.fileName === `${fileName}.map`)?.outputText;
}

function sourceFileNameForTab(sourceFile: string): string {
  const fixtureRelativeName = sourceFile.replace(/^.*\/input\//u, "");

  if (currentFiles().some((file) => file.fileName === fixtureRelativeName)) {
    return fixtureRelativeName;
  }

  const sourceBaseName = sourceFile.split("/").at(-1);

  return currentFiles().find((file) => file.fileName.split("/").at(-1) === sourceBaseName)
    ?.fileName ?? fixtureRelativeName;
}

function positionForLineAndColumn(
  state: EditorState,
  lineNumber: number,
  columnNumber: number,
): number {
  const line = state.doc.line(Math.max(1, Math.min(lineNumber, state.doc.lines)));

  return clampPosition(line.from + Math.max(0, columnNumber - 1), state.doc.length);
}

function tokenSelectionAround(
  state: EditorState,
  position: number,
): {
  from: number;
  to: number;
} {
  const text = state.doc.toString();
  let from = clampPosition(position, text.length);
  let to = from;

  while (from > 0 && isTokenCharacter(text[from - 1]!)) {
    from--;
  }

  while (to < text.length && isTokenCharacter(text[to]!)) {
    to++;
  }

  if (from === to) {
    to = Math.min(text.length, from + 1);
  }

  return {from, to};
}

function isTokenCharacter(character: string): boolean {
  return /[$\w]/u.test(character);
}

function originalPositionForGeneratedLocation(
  sourceMapText: string,
  line: number,
  column: number,
): {
  column: number;
  line: number;
  sourceFile: string;
} | undefined {
  const sourceMap = parsedSourceMap(sourceMapText);
  const lineMappings = sourceMap.mappings.filter((mapping) =>
    mapping.generatedLine === line - 1
  );
  let best: SourceMapMapping | undefined;

  for (const mapping of lineMappings) {
    if (mapping.generatedColumn <= column - 1) {
      best = mapping;
    }
  }

  return best
    ? {
        column: best.sourceColumn + 1,
        line: best.sourceLine + 1,
        sourceFile: best.sourceFile,
      }
    : undefined;
}

function parsedSourceMap(sourceMapText: string): SourceMapLookup {
  const sourceMap = JSON.parse(sourceMapText) as {
    mappings: string;
    sources: string[];
  };

  return {
    mappings: decodeMappings(sourceMap.mappings, sourceMap.sources),
    sources: sourceMap.sources,
  };
}

function decodeMappings(mappings: string, sourceFiles: string[]): SourceMapMapping[] {
  const decoded: SourceMapMapping[] = [];
  let previousSourceIndex = 0;
  let previousSourceLine = 0;
  let previousSourceColumn = 0;

  mappings.split(";").forEach((line, generatedLine) => {
    let previousGeneratedColumn = 0;

    for (const segment of line.split(",").filter(Boolean)) {
      const values = decodeVlqSegment(segment);

      if (values.length < 4) {
        continue;
      }

      previousGeneratedColumn += values[0]!;
      previousSourceIndex += values[1]!;
      previousSourceLine += values[2]!;
      previousSourceColumn += values[3]!;
      decoded.push({
        generatedColumn: previousGeneratedColumn,
        generatedLine,
        sourceColumn: previousSourceColumn,
        sourceFile: sourceFiles[previousSourceIndex] ?? "",
        sourceLine: previousSourceLine,
      });
    }
  });

  return decoded;
}

function decodeVlqSegment(segment: string): number[] {
  const values: number[] = [];
  let shift = 0;
  let value = 0;

  for (const character of segment) {
    const digit = base64Values.get(character) ?? 0;
    const continuation = Boolean(digit & 32);

    value += (digit & 31) << shift;

    if (continuation) {
      shift += 5;
      continue;
    }

    values.push(value & 1 ? -(value >> 1) : value >> 1);
    value = 0;
    shift = 0;
  }

  return values;
}

function applySourceDiagnostics() {
  sourceView.dispatch(setDiagnostics(sourceView.state, diagnosticsForCurrentSource()));
}

function diagnosticsForCurrentSource(): CodeMirrorDiagnostic[] {
  const length = sourceView.state.doc.length;

  return sourceDiagnostics
    .filter((diagnostic) => diagnostic.fileName === currentFileName)
    .map((diagnostic) => {
      const from = clampPosition(diagnostic.from, length);
      const to = clampPosition(Math.max(diagnostic.to, diagnostic.from + 1), length);

      return {
        from,
        message: `${diagnostic.code}: ${diagnostic.message}`,
        severity: diagnostic.severity,
        to: Math.max(from, to),
      };
    });
}

function clampPosition(position: number, length: number) {
  return Math.max(0, Math.min(position, length));
}

function replaceDocument(view: EditorView, text: string) {
  replacingDocument = true;
  view.dispatch({
    changes: {
      from: 0,
      insert: text,
      to: view.state.doc.length,
    },
  });
  replacingDocument = false;
}

async function fetchJson<Result>(url: string, options?: RequestInit): Promise<Result> {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<Result>;
}
