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
import {Compartment, EditorSelection, EditorState} from "@codemirror/state";
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
import type {
  CompileRequest,
  CompileResult,
  Example,
  ExampleFile,
  PlaygroundDiagnostic,
} from "./protocol.ts";

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

type ShareState = {
  entryFileName: string;
  files: ExampleFile[];
};

const examplesSelect = query<HTMLSelectElement>("#examples");
const sourceElement = query<HTMLElement>("#source");
const sourceTabs = query<HTMLElement>("#sourceTabs");
const outputTabs = query<HTMLElement>("#outputTabs");
const outputElement = query<HTMLElement>("#output");
const diagnostics = query<HTMLElement>("#diagnostics");
const diagnosticsText = query<HTMLElement>("#diagnosticsText");
const outputSelectionText = query<HTMLElement>("#outputSelectionText");
const shareButton = query<HTMLButtonElement>("#shareButton");
const sharePopover = query<HTMLElement>("#sharePopover");
const shareUrlInput = query<HTMLInputElement>("#shareUrl");
const shareCopyButton = query<HTMLButtonElement>("#shareCopy");
const copyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-copy-target]"));
const sourceLanguage = new Compartment();
const outputLanguage = new Compartment();
const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Values = new Map(Array.from(base64Digits, (digit, index) => [digit, index]));
const compilerWorker = new Worker("compiler-worker.js", {type: "module"});
const sharedExampleId = "__shared__";
let nextCompileRequestId = 0;
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
          clearStateParams();
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
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) {
          updateOutputSelectionInfo();
        }
      }),
    ],
  }),
});

void boot();

async function boot() {
  examples = await fetchJson<Example[]>("examples.json");
  populateExamples(examples);

  const shared = await sharedExampleFromLocation();

  if (shared) {
    applyExample(shared, {updateUrl: false});
  } else {
    selectedExample = exampleFromLocation() ?? examples[0];

    if (selectedExample) {
      loadExample(selectedExample.id, {updateUrl: false});
    } else {
      diagnosticsText.textContent = "No fixtures found.";
      outputSelectionText.textContent = "No output selected.";
    }
  }

  examplesSelect.addEventListener("change", () => loadExample(examplesSelect.value));
  document.addEventListener("keydown", handleExampleHotkey);

  for (const button of copyButtons) {
    button.addEventListener("click", () => void copyPanelText(button));
  }

  setupShare();
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
          clearSourceHighlight();
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
  const example = examples.find((item) => item.id === id);

  if (!example) {
    return;
  }

  applyExample(example, options);
}

function applyExample(example: Example, options: {updateUrl?: boolean} = {}) {
  if (example.id === sharedExampleId) {
    ensureSharedOption();
  }

  selectedExample = example;
  loadingExample = true;
  examplesSelect.value = example.id;
  currentFileName = example.entryFileName;
  currentOutputFileName = example.entryFileName;
  renderSourceTabs();
  loadCurrentSource();
  sourceDiagnostics = [];
  lastCompileResult = {
    diagnostics: "No diagnostics.",
    outputFiles: example.outputFiles,
    outputText: example.outputFiles.find((file) => file.fileName === currentFileName)?.outputText ?? "",
    sourceDiagnostics: [],
  };
  synchronizeOutputFile(currentFileName);
  renderOutputTabs();
  renderOutput();
  loadingExample = false;

  if (options.updateUrl ?? true) {
    setExampleParam(example.id);
  }

  void compileNow();
}

function ensureSharedOption() {
  if (examplesSelect.querySelector(`option[value="${sharedExampleId}"]`)) {
    return;
  }

  const option = document.createElement("option");

  option.value = sharedExampleId;
  option.textContent = "Shared snapshot";
  examplesSelect.prepend(option);
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

function clearStateParams() {
  const url = new URL(location.href);

  if (!url.searchParams.has("example") && !url.searchParams.has("share")) {
    return;
  }

  url.searchParams.delete("example");
  url.searchParams.delete("share");
  history.replaceState(null, "", url);
}

async function compileNow() {
  saveCurrentSource();

  try {
    const result = await compileInWorker(compileRequest());

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
    updateOutputSelectionInfo();
  }
}

function compileRequest(): CompileRequest {
  return {
    entryFileName: selectedExample?.entryFileName ?? "main.ts",
    files: currentFiles(),
  };
}

function compileInWorker(request: CompileRequest): Promise<CompileResult> {
  const id = nextCompileRequestId++;

  return new Promise((resolve, reject) => {
    const handleMessage = (event: MessageEvent<{
      error?: string;
      id: number;
      result?: CompileResult;
    }>) => {
      if (event.data.id !== id) {
        return;
      }

      compilerWorker.removeEventListener("message", handleMessage);
      compilerWorker.removeEventListener("error", handleError);

      if (event.data.result) {
        resolve(event.data.result);
      } else {
        reject(new Error(event.data.error ?? "Compiler worker failed."));
      }
    };
    const handleError = (event: ErrorEvent) => {
      compilerWorker.removeEventListener("message", handleMessage);
      compilerWorker.removeEventListener("error", handleError);
      reject(event.error instanceof Error ? event.error : new Error(event.message));
    };

    compilerWorker.addEventListener("message", handleMessage);
    compilerWorker.addEventListener("error", handleError);
    compilerWorker.postMessage({id, request});
  });
}

function renderOutput() {
  const outputFile = currentOutputFile();

  outputView.dispatch({
    effects: outputLanguage.reconfigure(languageForOutputFile(currentOutputFileName)),
  });
  replaceDocument(outputView, outputFile?.outputText ?? lastCompileResult?.outputText ?? "");
  updateOutputSelectionInfo();
}

function updateOutputSelectionInfo() {
  outputSelectionText.textContent = formatOutputSelectionInfo();
}

function formatOutputSelectionInfo(): string {
  const selection = outputView.state.selection.main;
  const head = clampPosition(selection.head, outputView.state.doc.length);
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  const outputLocation = locationForPosition(outputView.state, head);
  const selectedText = outputView.state.sliceDoc(from, to);
  const lines = [
    `Output: ${formatLocation(currentOutputFileName || "(none)", outputLocation, head)}`,
    selection.empty
      ? "Selection: cursor"
      : `Selection: ${formatRange(outputView.state, currentOutputFileName, from, to)}`,
    `Cursor token: ${JSON.stringify(tokenTextAround(outputView.state.doc.toString(), head))}`,
  ];

  if (!selection.empty) {
    lines.push("Selected text:", indentText(summarizeText(selectedText)));
  }

  lines.push(
    "Output line:",
    outputLocation.lineText,
    caretLine(outputLocation.column, selection.empty ? 1 : Math.max(1, to - from)),
    "",
    ...sourceMapInfoLines(outputLocation.line, outputLocation.column),
  );

  return lines.join("\n");
}

function sourceMapInfoLines(generatedLine: number, generatedColumn: number): string[] {
  if (!currentOutputFileName) {
    return ["Source map: no output file selected."];
  }

  if (currentOutputFileName.endsWith(".map")) {
    return ["Source map: source map output files do not map back to source."];
  }

  const sourceMapFileName = `${currentOutputFileName}.map`;
  const sourceMapText = sourceMapTextForOutput(currentOutputFileName);

  if (!sourceMapText) {
    return [`Source map: no ${sourceMapFileName} output file is available.`];
  }

  let original: ReturnType<typeof originalPositionForGeneratedLocation>;

  try {
    original = originalPositionForGeneratedLocation(sourceMapText, generatedLine, generatedColumn);
  } catch (error) {
    return [`Source map: could not read ${sourceMapFileName}: ${errorMessage(error)}`];
  }

  if (!original) {
    return [`Source map: no mapping at ${currentOutputFileName}:${generatedLine}:${generatedColumn}.`];
  }

  const sourceTabName = sourceFileNameForTab(original.sourceFile);
  const sourceFile = currentFiles().find((file) => file.fileName === sourceTabName);
  const sourceTextForFile = sourceFile?.source ?? "";
  const sourceLineText = lineTextAt(sourceTextForFile, original.line);
  const sourceOffset = sourceOffsetForLineAndColumn(
    sourceTextForFile,
    original.line,
    original.column,
  );

  return [
    `Source map: ${sourceMapFileName}`,
    `Original: ${original.sourceFile}:${original.line}:${original.column}`,
    `Source tab: ${sourceTabName}${sourceFile ? "" : " (not loaded)"}`,
    `Source offset: ${sourceOffset}`,
    `Source token: ${JSON.stringify(tokenTextAround(sourceTextForFile, sourceOffset))}`,
    "Source line:",
    sourceLineText,
    caretLine(original.column, 1),
  ];
}

function locationForPosition(state: EditorState, position: number): {
  column: number;
  line: number;
  lineText: string;
} {
  const line = state.doc.lineAt(clampPosition(position, state.doc.length));

  return {
    column: position - line.from + 1,
    line: line.number,
    lineText: line.text,
  };
}

function formatLocation(fileName: string, location: {column: number; line: number}, offset: number) {
  return `${fileName}:${location.line}:${location.column} (offset ${offset})`;
}

function formatRange(state: EditorState, fileName: string, from: number, to: number) {
  const start = locationForPosition(state, from);
  const end = locationForPosition(state, to);

  return [
    formatLocation(fileName, start, from),
    "to",
    formatLocation(fileName, end, to),
  ].join(" ");
}

function tokenTextAround(text: string, position: number) {
  const range = tokenRangeAroundText(text, position);

  return text.slice(range.from, range.to);
}

function tokenRangeAroundText(text: string, position: number): {
  from: number;
  to: number;
} {
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

function summarizeText(text: string) {
  if (text.length <= 400) {
    return text || "(empty)";
  }

  return `${text.slice(0, 400)}\n... (${text.length - 400} more characters)`;
}

function indentText(text: string) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function lineTextAt(text: string, lineNumber: number) {
  const start = lineStartOffset(text, lineNumber);
  const end = text.indexOf("\n", start);

  return text.slice(start, end === -1 ? text.length : end).replace(/\r$/u, "");
}

function sourceOffsetForLineAndColumn(text: string, lineNumber: number, columnNumber: number) {
  const start = lineStartOffset(text, lineNumber);
  const end = text.indexOf("\n", start);
  const lineEnd = end === -1 ? text.length : end;

  return clampPosition(start + Math.max(0, columnNumber - 1), lineEnd);
}

function lineStartOffset(text: string, lineNumber: number) {
  let start = 0;

  for (let line = 1; line < lineNumber; line++) {
    const next = text.indexOf("\n", start);

    if (next === -1) {
      return text.length;
    }

    start = next + 1;
  }

  return start;
}

function caretLine(columnNumber: number, length: number) {
  return `${" ".repeat(Math.max(0, columnNumber - 1))}${"^".repeat(Math.min(Math.max(1, length), 80))}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function copyPanelText(button: HTMLButtonElement) {
  const targetId = button.dataset.copyTarget;
  const target = targetId ? document.getElementById(targetId) : undefined;
  const text = target?.textContent ?? "";
  const originalTitle = button.title;

  try {
    await navigator.clipboard.writeText(text);
    button.title = "Copied";
  } catch {
    button.title = "Copy failed";
  }

  setTimeout(() => {
    button.title = originalTitle;
  }, 900);
}

function setupShare() {
  shareButton.addEventListener("click", () => toggleSharePopover());
  shareCopyButton.addEventListener("click", () => void copyShareUrl());
  shareUrlInput.addEventListener("focus", () => shareUrlInput.select());

  document.addEventListener("click", (event) => {
    if (sharePopover.hidden) {
      return;
    }

    const target = event.target as Node;

    if (target !== shareButton && !sharePopover.contains(target)) {
      closeSharePopover();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !sharePopover.hidden) {
      closeSharePopover();
      shareButton.focus();
    }
  });
}

function toggleSharePopover() {
  if (sharePopover.hidden) {
    openSharePopover();
  } else {
    closeSharePopover();
  }
}

function openSharePopover() {
  shareCopyButton.textContent = "Copy";
  shareUrlInput.value = "Generating link…";
  sharePopover.hidden = false;
  shareButton.setAttribute("aria-expanded", "true");
  void fillShareUrl();
}

async function fillShareUrl() {
  const url = await buildShareUrl();

  // The popover may have been closed while the link was being compressed.
  if (sharePopover.hidden) {
    return;
  }

  // Reflect the encoded snapshot in the address bar so the page itself is shareable.
  history.replaceState(null, "", url);
  shareUrlInput.value = url;
  shareUrlInput.focus();
  shareUrlInput.select();
}

function closeSharePopover() {
  sharePopover.hidden = true;
  shareButton.setAttribute("aria-expanded", "false");
}

async function copyShareUrl() {
  try {
    await navigator.clipboard.writeText(shareUrlInput.value);
    shareCopyButton.textContent = "Copied";
  } catch {
    shareUrlInput.select();
    shareCopyButton.textContent = "Copy failed";
  }

  setTimeout(() => {
    shareCopyButton.textContent = "Copy";
  }, 1200);
}

async function buildShareUrl(): Promise<string> {
  const url = new URL(location.href);

  url.searchParams.delete("example");
  url.searchParams.set("share", await encodeShareState(buildShareState()));

  return url.toString();
}

function buildShareState(): ShareState {
  saveCurrentSource();

  return {
    entryFileName: selectedExample?.entryFileName ?? currentFileName ?? "main.ts",
    files: currentFiles().map((file) => ({fileName: file.fileName, source: file.source})),
  };
}

async function sharedExampleFromLocation(): Promise<Example | undefined> {
  const encoded = new URL(location.href).searchParams.get("share");

  if (!encoded) {
    return undefined;
  }

  const state = await decodeShareState(encoded);

  if (!state || state.files.length === 0) {
    diagnosticsText.textContent = "Could not read shared link.";
    return undefined;
  }

  const entryFileName = state.files.some((file) => file.fileName === state.entryFileName)
    ? state.entryFileName
    : state.files[0]!.fileName;

  return {
    entryFileName,
    files: state.files,
    group: "Shared",
    id: sharedExampleId,
    name: "Shared snapshot",
    outputFiles: [],
  };
}

async function encodeShareState(state: ShareState): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const compressed = await pipeThroughStream(bytes, new CompressionStream("gzip"));

  return base64UrlFromBytes(compressed);
}

async function decodeShareState(encoded: string): Promise<ShareState | undefined> {
  try {
    const compressed = bytesFromBase64Url(encoded);
    const bytes = await pipeThroughStream(compressed, new DecompressionStream("gzip"));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as ShareState;

    if (!parsed || !Array.isArray(parsed.files)) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}

async function pipeThroughStream(
  bytes: Uint8Array<ArrayBuffer>,
  transform: GenericTransformStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function bytesFromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  const base64 = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function navigateToSourceMapLocation(generatedLine: number, generatedColumn: number) {
  if (currentOutputFileName.endsWith(".map")) {
    clearSourceHighlight();
    return false;
  }

  const sourceMapText = sourceMapTextForOutput(currentOutputFileName);
  const original = sourceMapText
    ? originalPositionForGeneratedLocation(sourceMapText, generatedLine, generatedColumn)
    : undefined;

  if (!original) {
    clearSourceHighlight();
    return false;
  }

  const fileName = sourceFileNameForTab(original.sourceFile);

  if (!currentFiles().some((file) => file.fileName === fileName)) {
    clearSourceHighlight();
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

function clearSourceHighlight() {
  sourceView.dispatch({
    selection: EditorSelection.cursor(sourceView.state.selection.main.head),
  });
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
  return tokenRangeAroundText(state.doc.toString(), position);
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
