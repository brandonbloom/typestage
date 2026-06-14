/**
 * Local browser playground for trying TypeStage fixtures and ad hoc input.
 * Examples are read from the fixture tree at request time so the playground
 * reflects newly added cases while the Bun watcher restarts the server.
 */
import {existsSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {compilePlaygroundRequest, playgroundErrorResult} from "./compiler.ts";
import type {CompileRequest, Example} from "./protocol.ts";

const fixturesRoot = join(process.cwd(), "tests", "fixtures");
const port = Number(Bun.env.PORT ?? 3000);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/": {
      GET() {
        return playgroundAssetResponse("index.html", "text/html; charset=utf-8");
      },
    },
    "/api/examples": {
      GET() {
        return Response.json(readExamples());
      },
    },
    "/examples.json": {
      GET() {
        return Response.json(readExamples(), {
          headers: {
            "cache-control": "no-store",
          },
        });
      },
    },
    "/playground.css": {
      GET() {
        return playgroundAssetResponse("playground.css", "text/css; charset=utf-8");
      },
    },
    "/playground-client.js": {
      async GET() {
        return playgroundScriptResponse("client.ts");
      },
    },
    "/compiler-worker.js": {
      async GET() {
        return playgroundScriptResponse("compiler-worker.ts");
      },
    },
    "/api/compile": {
      async POST(request) {
        try {
          return Response.json(await compilePlaygroundRequest(
            (await request.json()) as CompileRequest,
          ));
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

function playgroundAssetResponse(fileName: string, contentType: string): Response {
  return new Response(readFileSync(join(import.meta.dir, fileName), "utf8"), {
    headers: {
      "cache-control": "no-store",
      "content-type": contentType,
    },
  });
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

async function playgroundScriptResponse(entrypoint: string): Promise<Response> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, entrypoint)],
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
