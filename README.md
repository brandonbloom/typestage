# TypeStage

TypeStage is staged metaprogramming for TypeScript. It lets ordinary
TypeScript programs build other TypeScript programs using syntax-aware quotes,
splices, hygiene, source locations, and TypeScript ASTs instead of string
templates.

The project is aimed at people writing compilers, DSLs, generators, and
language tools whose target is TypeScript. TypeScript is already a good host
language for compiler implementation; TypeStage tries to make it a better
substrate for emitting TypeScript.

```ts
import {q} from "typestage";

const fields = ["id", "name", "email"].map((name) =>
  q.ident`${name}: string`
);

const trimCalls = fields.map((field) => q.expr`${field}.trim()`);
const packValues = q.ident`packValues`;

export const generated = q.decls`
  export type Row = Record<string, string>;

  export function pack(${fields}) {
    return packValues(${trimCalls});
  }
`;
```

That example is intentionally small, but it shows the shape of the system:
host TypeScript computes with data, quoted fragments carry TypeScript syntax,
and splices insert syntax into syntax. The compiler runs the staging module,
captures real interpolation values, expands code fragments, preserves useful
source locations, and emits ordinary TypeScript.

String templating makes code generation feel easy until the generated program
needs to be renamed, typechecked, source mapped, or composed with other
generators. TypeStage keeps the same directness while moving the fragile parts
into a compiler pipeline that understands TypeScript grammar and binding
positions.

For a tour of the concepts and the major quote forms, start with the
[docs](docs/README.md).

## Status

TypeStage is experimental. The public surface and semantics are still being
shaped through fixtures and examples.

Useful commands:

```sh
bun test
bun run typecheck
bun run build
bun run playground
```
