import {existsSync, readFileSync, statSync} from "node:fs";
import {extname, join, resolve} from "node:path";

const root = resolve(process.cwd(), "dist", "playground");
const port = Number(Bun.env.PORT ?? 3000);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    const path = resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);

    if (!path.startsWith(root) || !existsSync(path) || !statSync(path).isFile()) {
      return new Response("Not found", {status: 404});
    }

    return new Response(readFileSync(path), {
      headers: {
        "content-type": contentType(path),
      },
    });
  },
});

console.log(`TypeStage playground preview: http://localhost:${server.port}`);

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
