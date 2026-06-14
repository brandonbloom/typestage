import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {join} from "node:path";
import type {Example} from "../src/playground/protocol.ts";

const projectRoot = process.cwd();
const fixturesRoot = join(projectRoot, "tests", "fixtures");
const outDir = join(projectRoot, "dist", "playground");

rmSync(outDir, {force: true, recursive: true});
mkdirSync(outDir, {recursive: true});

copyFileSync(
  join(projectRoot, "src", "playground", "index.html"),
  join(outDir, "index.html"),
);
copyFileSync(
  join(projectRoot, "src", "playground", "playground.css"),
  join(outDir, "playground.css"),
);
writeFileSync(
  join(outDir, "examples.json"),
  `${JSON.stringify(readExamples(), null, 2)}\n`,
);

const build = await Bun.build({
  entrypoints: [
    join(projectRoot, "src", "playground", "client.ts"),
    join(projectRoot, "src", "playground", "compiler-worker.ts"),
  ],
  format: "esm",
  minify: true,
  outdir: outDir,
  target: "browser",
});

if (!build.success) {
  for (const log of build.logs) {
    console.error(log.message);
  }

  process.exit(1);
}

renameSync(join(outDir, "client.js"), join(outDir, "playground-client.js"));

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
        group,
        id: `${directoryName}/${entry.name}`,
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
