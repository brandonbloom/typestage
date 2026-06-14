export type ExampleFile = {
  fileName: string;
  source: string;
};

export type OutputFile = {
  fileName: string;
  outputText: string;
};

export type PlaygroundDiagnostic = {
  code: string;
  fileName: string;
  from: number;
  message: string;
  severity: "error";
  to: number;
};

export type Example = {
  entryFileName: string;
  files: ExampleFile[];
  id: string;
  group: string;
  name: string;
  outputFiles: OutputFile[];
};

export type CompileRequest = {
  entryFileName?: string;
  files?: ExampleFile[];
};

export type CompileResult = {
  diagnostics: string;
  outputFiles: OutputFile[];
  outputText: string;
  sourceDiagnostics: PlaygroundDiagnostic[];
};
