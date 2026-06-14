import {describe, expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {LinesAndColumns} from "lines-and-columns";
import {compileFileGraph, originalPositionForGeneratedLocation} from "typestage";

type OriginAssertions = OriginAssertion[];

type OriginAssertion = {
  generated: LocationSelector;
  name: string;
  source: TextSelector;
};

type LocationSelector = ({
  column: number;
  line: number;
} | TextSelector) & {
  file: string;
};

type TextSelector = {
  file: string;
  occurrence?: number;
  text: string;
};

const fixturesRoot = join(import.meta.dir, "fixtures");
const originAssertionsGlob = new Bun.Glob("{pass,typecheck}/*/origins.json");

describe("TypeStage source map origins", () => {
  for (const fixture of originFixtures()) {
    describe(`${fixture.group}/${fixture.caseName}`, () => {
      for (const assertion of fixture.assertions) {
        test(assertion.name, async () => {
          await assertGeneratedLocationMapsToSource(fixture.caseRoot, assertion);
        });
      }
    });
  }
});

function originFixtures(): Array<{
  assertions: OriginAssertions;
  caseName: string;
  caseRoot: string;
  group: string;
}> {
  return Array.from(originAssertionsGlob.scanSync({cwd: fixturesRoot}))
    .map((assertionsPath) => {
      const [group = "", caseName = ""] = assertionsPath.split("/");
      const caseRoot = join(fixturesRoot, dirname(assertionsPath));

      return {
        assertions: JSON.parse(
          readFileSync(join(fixturesRoot, assertionsPath), "utf8"),
        ) as OriginAssertions,
        caseName,
        caseRoot,
        group,
      };
    })
    .sort((left, right) =>
      left.group.localeCompare(right.group) ||
      left.caseName.localeCompare(right.caseName)
    );
}

async function assertGeneratedLocationMapsToSource(
  caseRoot: string,
  assertion: OriginAssertion,
) {
  const result = await compileFileGraph(entryPath(caseRoot), {
    sourceMaps: true,
    sourceRoot: join(caseRoot, "input"),
  });
  const outputFile = result.files.find((file) =>
    file.outputPath === assertion.generated.file
  );

  expect(outputFile?.sourceMapText).toBeDefined();

  const generatedLocation = generatedLocationForSelector(
    outputFile!.outputText,
    assertion.generated,
  );
  const original = originalPositionForGeneratedLocation(
    outputFile!.sourceMapText!,
    generatedLocation.line,
    generatedLocation.column,
  );
  const inputPath = join(caseRoot, "input", assertion.source.file);
  const expectedLocation = textLocation(
    readFileSync(inputPath, "utf8"),
    assertion.source.text,
    assertion.source.occurrence,
  );

  expect(original).toBeDefined();
  expect(resolve(process.cwd(), original!.sourceFile)).toBe(resolve(inputPath));
  expect(original!.line).toBe(expectedLocation.line);
  expect(original!.column).toBe(expectedLocation.column);
}

function entryPath(caseRoot: string): string {
  return join(caseRoot, "input", "main.ts");
}

function generatedLocationForSelector(
  outputText: string,
  selector: LocationSelector,
): {
  column: number;
  line: number;
} {
  if ("text" in selector) {
    return textLocation(outputText, selector.text, selector.occurrence);
  }

  return {
    column: selector.column,
    line: selector.line,
  };
}

function textLocation(text: string, needle: string, occurrence = 1): {
  column: number;
  line: number;
} {
  let index = -1;
  let searchStart = 0;

  for (let count = 0; count < occurrence; count++) {
    index = text.indexOf(needle, searchStart);

    if (index < 0) {
      throw new Error(`could not find '${needle}' occurrence ${occurrence}`);
    }

    searchStart = index + needle.length;
  }

  const location = new LinesAndColumns(text).locationForIndex(index);

  if (!location) {
    throw new Error(`could not locate '${needle}' occurrence ${occurrence}`);
  }

  return {
    column: location.column + 1,
    line: location.line + 1,
  };
}
