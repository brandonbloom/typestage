import {compilePlaygroundRequest} from "./compiler.ts";
import type {CompileRequest, CompileResult} from "./protocol.ts";

type WorkerRequest = {
  id: number;
  request: CompileRequest;
};

type WorkerResponse = {
  error?: string;
  id: number;
  result?: CompileResult;
};

const worker = globalThis as unknown as {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void;
  postMessage(message: WorkerResponse): void;
};

worker.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  void handleCompileRequest(event.data);
});

async function handleCompileRequest(message: WorkerRequest) {
  try {
    worker.postMessage({
      id: message.id,
      result: await compilePlaygroundRequest(message.request),
    } satisfies WorkerResponse);
  } catch (error) {
    worker.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id: message.id,
    } satisfies WorkerResponse);
  }
}
