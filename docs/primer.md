# TypeStage Primer

TypeStage is staged metaprogramming for TypeScript. It is for people building
compilers, DSLs, generators, and language tools whose output is TypeScript.

The point is not to make code generation clever. The point is to make it less
fragile.

Most generators get pushed toward one side of a false tradeoff. Text templates
are direct: the generator looks like the output, and a reader can recognize the
TypeScript being produced. But the generator author is left manually managing
precedence, escaping, sequence separators, binding collisions, source locations,
and every syntactic boundary in the target language.

Raw AST construction solves some of those problems. It gives the printer real
syntax, so parentheses, commas, and formatting are no longer all handwritten.
But it also makes the generator look nothing like the output. A small emitted
function can turn into a page of factory calls, and the conceptual distance
between "the TypeScript I want" and "the TypeScript nodes I must build" becomes
its own source of bugs. AST construction also does not automatically solve
hygiene: the tree may be syntactically valid while still accidentally capturing
or shadowing names.

TypeStage tries to take the useful half of both approaches. Quotes let generated
code look like code. Splices let generators compose that code using host
TypeScript. Internally, the generated program is still syntax all the way down:
expressions are expressions, declarations are declarations, types are types, and
identifiers can participate in binding-aware operations.

This primer is a quick path through the mental model and the major constructs.
Each feature is shown as source TypeStage code followed by the residual
TypeScript it emits.

## 1. Host Code and Residual Code

A TypeStage input file contains two stages of code:

- **Host code** is ordinary TypeScript that runs while TypeStage compiles the
  module.
- **Residual code** is the TypeScript module TypeStage emits.

A quote moves from the host stage into residual syntax. A splice moves back to
the host stage to fetch a value.

**Source**

```ts
import {q} from "typestage";

const incremented = q.expr`input + 1`;

export const expr = q.expr`
  incremented * scale
`;
```

**Output**

```ts
export const expr = ((input + 1) * scale);
```

The host binding `incremented` is not a string. It is a TypeStage expression
fragment. When `incremented` appears inside the second expression quote,
TypeStage recognizes the host binding and implicitly unquotes it. The fragment
is inserted as expression syntax, preserving the surrounding operator structure.
The extra parentheses in the output are intentionally conservative; the emitted
program is ordinary TypeScript.

This is the basic staging loop:

1. Run host TypeScript.
2. Capture quoted TypeScript fragments and interpolation values.
3. Expand splices.
4. Emit residual TypeScript.

## 2. Quote Forms

Every quote form chooses a TypeScript grammar entry point. This is one of the
main differences from string templating: the shape of the quote constrains what
can be spliced into it.

The common singular quote forms are:

- `q.expr` for one expression.
- `q.ident` for one identifier, optionally with a type annotation.
- `q.type` for one type.
- `q.pattern` for one binding pattern.
- `q.stmt` for one statement.
- `q.block` for a statement block that can adapt to expression positions when
  that adaptation is safe.
- `q.decl` for declarations.

Plural forms such as `q.exprs`, `q.types`, `q.patterns`, and `q.decls` quote
sequence-shaped syntax. Sequences matter whenever TypeScript expects
comma-separated or statement-separated syntax: call arguments, parameters, tuple
elements, type arguments, and top-level declarations.

## 3. Explicit Splicing

`${...}` inside a quote is an explicit splice. If the interpolation value is
TypeStage code, TypeStage inserts it as syntax. The expected syntax family comes
from the surrounding quote position.

**Source**

```ts
import {q} from "typestage";

const tests = [
  q.expr`input.active`,
  q.expr`input.emailVerified`,
];

export const decl = q.decl`
  export function keep(input: User) {
    return ${tests[0]} && ${tests[1]};
  }
`;
```

**Output**

```ts
export function keep(input: User) {
    return input.active && input.emailVerified;
}
```

Each splice occurs in expression position, so `tests[0]` and `tests[1]` must
both be expression-shaped. The bracketed host expressions make this a genuinely
explicit splice example; a plain host binding name can often be written with
implicit unquoting instead. If you try to put a statement fragment where an
expression belongs, TypeStage reports a diagnostic instead of guessing.

That constraint is what makes fragments composable. A generator can hand an
expression fragment to another generator without also handing along separator
rules, precedence rules, or a warning label that says "please paste this only in
the right place."

## 4. Implicit Unquoting

Explicit splices are useful when the host expression is not just a plain binding
name, but small templates often read better when nearby code-valued host
bindings can be referenced directly. If a host binding is known to contain
compatible TypeStage code, and no residual binding shadows it, TypeStage treats
the name as an implicit unquote.

**Source**

```ts
import {q} from "typestage";

const normalized = q.expr`
  input.trim().toLowerCase()
`;

export const decl = q.decl`
  export function normalize(input: string) {
    return normalized;
  }
`;
```

**Output**

```ts
export function normalize(input: string) {
    return input.trim().toLowerCase();
}
```

Implicit unquoting is lexical. If the residual code introduces its own binding
named `normalized`, that residual binding wins. This keeps short templates
pleasant without turning every identifier into a magical host lookup.

Use explicit splices when you want the dataflow to be obvious. Use implicit
unquoting when a local helper fragment is part of the surrounding template and
the quote reads better as code.

## 5. Persistent Values

Not every splice has to be code. TypeStage runs the staging module, captures
actual interpolation values, and serializes supported values into residual
expressions. This is multi-stage persistence: host values can become residual
values.

**Source**

```ts
import {q} from "typestage";

const settings = {
  enabled: true,
  thresholds: new Map([
    ["low", 2],
    ["high", 10],
  ]),
  launchedAt: new Date("2026-06-13T00:00:00.000Z"),
};

export const expr = q.expr`
  configure(${settings})
`;
```

**Output**

```ts
export const expr = (configure({
    enabled: true,
    thresholds: new Map([
        ["low", 2],
        ["high", 10]
    ]),
    launchedAt: new Date("2026-06-13T00:00:00.000Z")
}));
```

Persistence is useful for computed constants, lookup tables, configuration
objects, generated schemas, and other host-stage data that should appear in the
emitted program.

The supported set is deliberately small: `undefined`, `null`, booleans,
strings, numbers including `NaN`, infinities, and `-0`, bigints, dense arrays,
plain objects, `Date`, `RegExp`, `Map`, `Set`, and global symbols. Unsupported
values produce diagnostics. TypeStage does not pretend that functions, class
instances, promises, accessors, cycles, or arbitrary object graphs have an
obvious TypeScript expression form.

## 6. Sequence Splicing and Arity

Many TypeScript positions are sequence-shaped. Calls contain argument
sequences. Functions contain parameter sequences. Tuples contain element
sequences. Modules contain declaration sequences.

TypeStage represents this explicitly. A singular quote produces one syntax node.
A plural quote produces a sequence. Arrays of compatible fragments can also be
spliced into sequence positions.

**Source**

```ts
import {q} from "typestage";

const args = q.exprs`a, b`;
const suffix = q.expr`c`;

export const callExpr = q.expr`
  fn(0, ${args}, suffix, 3)
`;
```

**Output**

```ts
export const callExpr = (fn(0, a, b, c, 3));
```

The important rule is that TypeStage preserves arity. Two expressions can be
spliced into an argument sequence, but they cannot be silently collapsed into a
single expression position. TypeScript has a comma operator, but TypeStage does
not reinterpret a sequence splice as a comma expression because that would change
meaning in ways that are too subtle for a code generator substrate.

In the example above, `${args}` is explicit because it expands to a sequence.
The singleton expression fragment `suffix` can use implicit unquoting.

## 7. Types and Patterns

Expressions are only one syntax family. Compilers that emit TypeScript need to
generate types, binding patterns, and declarations as first-class syntax too.

Type fragments compose in type positions:

**Source**

```ts
import {q} from "typestage";

const Element = q.type`string`;
const Params = q.types`number, boolean`;
const Result = q.type`Date`;

export const decl = q.decl`
  export type Box = Array<${Element}>;
  export type Tuple = [${Params}];
  export type Handler = Fn<${Params}, Result>;
`;
```

**Output**

```ts
export type Box = Array<string>;
export type Tuple = [
    number,
    boolean
];
export type Handler = Fn<number, boolean, Date>;
```

Pattern fragments compose in binding positions:

**Source**

```ts
import {q} from "typestage";

const First = q.pattern`first`;
const Rest = q.patterns`second, {third}`;

export const decl = q.decl`
  export function collect(${First}, ${Rest}) {
    return [first, second, third];
  }
`;
```

**Output**

```ts
export function collect(first, second, { third }) {
    return [first, second, third];
}
```

This is where TypeStage starts to feel like a compiler-building substrate
rather than a template convenience. The generator can manipulate the same
syntactic categories the TypeScript compiler understands.

## 8. Statements and Blocks

Statements are syntax values too. A `q.stmt` fragment can be spliced into a
statement sequence, which is exactly what function bodies and blocks contain.

**Source**

```ts
import {q} from "typestage";

const body = q.stmt`
  const value = compute();
  return value;
`;

export const fn = q.decl`
  export function f() {
    ${body}
  }
`;
```

**Output**

```ts
export function f() {
    const value = compute();
    return value;
}
```

Blocks are useful when a generator wants to produce a small computation that
can later appear where an expression is expected. If a block has a safe
expression interpretation, TypeStage adapts it through an immediately invoked
function expression.

**Source**

```ts
import {q} from "typestage";

const body = q.block`
  {
    const value = compute();
    return value + 1;
  }
`;

export const expr = q.expr`
  ${body} * 2
`;
```

**Output**

```ts
export const expr = ((() => {
    const value = compute();
    return value + 1;
})() * 2);
```

The adaptation is intentionally limited. A block with unsafe control flow should
produce a diagnostic instead of being forced into an expression shape.

## 9. Identifiers and Binding Positions

Generators often need to turn semantic data into names. `q.ident` produces
identifier syntax. A typed identifier carries its type annotation into binding
positions and can also be used as an expression reference.

**Source**

```ts
import {q} from "typestage";

const fieldNames = ["id", "name", "email"];
const fields = fieldNames.map((fieldName) =>
  q.ident`${fieldName}: string`
);
const trimmedFields = fields.map((field) =>
  q.expr`${field}.trim()`
);

export const decl = q.decl`
  export function packFields(${fields}) {
    return pack(${trimmedFields});
  }
`;
```

**Output**

```ts
export function packFields(id: string, name: string, email: string) {
    return pack(id.trim(), name.trim(), email.trim());
}
```

This pattern shows up constantly in compilers. A parser or analyzer discovers
semantic names. The generator turns them into identifiers. The identifiers
appear in binding positions such as parameters, destructuring patterns, and
variable declarations, then appear again in expression positions as references.

The same identifier fragment can be reused in both places because it is not just
text. It is syntax with a known role.

## 10. Declaration Sequences

Top-level output is often many declarations. `q.decl` is useful for one
declaration-shaped template; `q.decls` is useful when a generator emits a
sequence of declarations from host data.

**Source**

```ts
import {q} from "typestage";

const names = ["id", "name"];
const fieldDeclarations = names.map((name) => {
  const field = q.ident`${name}: string`;

  return q.decl`
    export const ${field} = ${name};
  `;
});

export const decls = q.decls`
  export const fieldCount = ${names.length};
  ${fieldDeclarations}
`;
```

**Output**

```ts
export const fieldCount = 2;
export const id: string = "id";
export const name: string = "name";
```

There are two kinds of splice here. `${names.length}` persists a host number as
an expression. `${fieldDeclarations}` splices an array of declaration fragments.
Both are ordinary host computations feeding residual syntax.

## 11. Hygiene

Generated code has to manage names. The dangerous case is accidental capture:
a fragment contains a free reference, and the destination quote happens to
introduce a binding with the same name.

TypeStage tracks local bindings and free references in fragments. When an
introduced local would capture a free reference from a splice, TypeStage chooses
a fresh residual name for the introduced local.

**Source**

```ts
import {q} from "typestage";

const freeX = q.expr`x + 1`;

export const expr = q.expr`
  (() => {
    const x = 10;
    return freeX;
  })()
`;
```

**Output**

```ts
export const expr = ((() => {
    const x_1 = 10;
    return (x + 1);
})());
```

The `x` inside `x + 1` is free in the fragment. The `const x = 10` inside the
destination quote would accidentally capture it, so the introduced local becomes
`x_1`.

This is one of the main reasons TypeStage exists. String templating can paste
the same text, but it cannot know which occurrences are bindings, which are
references, and which collisions preserve or change meaning.

## 12. Modules

Generators do not need to live in one file. TypeStage compiles a local
TypeScript module graph from an entry file, resolves local imports and
re-exports, and emits one residual file per input module that has residual
output.

**Source**

```ts
// main.ts
import {q} from "typestage";
import {call} from "./parts";

const args = q.exprs`first, second`;

export const expr = q.expr`
  ${call(args)}
`;

// parts.ts
import {q} from "typestage";

export function call(args: unknown) {
  return q.expr`fn(${args})`;
}
```

**Output**

```ts
// main.ts
export const expr = (fn(first, second));

// parts.ts
```

The helper module exports a host-stage function that returns a TypeStage code
value. Calling it from `main.ts` is ordinary TypeScript execution during
staging. Because `parts.ts` produces no residual declarations in this example,
its emitted residual file is empty.

For larger generators, this is what lets you organize compiler code normally:
parsers, analyzers, lowering helpers, and syntax builders can live in separate
modules while still participating in one residual output graph.

## 13. A Compiler-Shaped Example

A small compiler has the same basic shape at any scale:

1. Read or construct some source-language facts in host TypeScript.
2. Lower those facts to TypeStage fragments.
3. Compose fragments with quotes and splices.
4. Emit residual TypeScript.

Here is a tiny record-schema generator. The "source language" is just host data,
but the shape is the same as a parser feeding a real compiler pipeline.

**Source**

```ts
import {q} from "typestage";

const source = {
  factoryName: "makeUser",
  fields: [
    ["id", "string"],
    ["age", "number"],
  ],
} as const;

function lowerField([name, type]: typeof source.fields[number]) {
  if (type === "number") {
    return q.ident`${name}: number`;
  }

  return q.ident`${name}: string`;
}

const factoryName = q.ident`${source.factoryName}`;
const params = source.fields.map(lowerField);
const properties = params.map((field) => q.expr`${field}`);

export const decl = q.decl`
  export function ${factoryName}(${params}) {
    return {${properties}};
  }
`;
```

**Output**

```ts
export function makeUser(id: string, age: number) {
    return { id, age };
}
```

This example is intentionally small, but it shows the important move: the
generator computes with semantic data, then emits TypeScript by constructing
syntax fragments. A real compiler would replace the inline `source` object with
an AST, an intermediate representation, or checked semantic model. The TypeStage
part remains the same: lower facts into syntax values and compose those values
into residual modules.

## 14. Library Support For Compiler Builders

The core language surface is quotes, splices, persistence, hygiene, and module
emission. On top of that, TypeStage can grow libraries that make compiler
implementation more pleasant: fragment collection helpers, lowering utilities,
debug printers, source-aware builders, name-generation helpers, and testing
support for generated code.

Those helpers should be libraries on top of the staging model. They should make
common compiler tasks easier without hiding the underlying idea that generated
TypeScript is represented as typed syntax fragments.

## 15. What To Read Next

- The fixture cases in [tests/fixtures/pass](../tests/fixtures/pass) are
  executable examples.
- [examples/lisp/README.md](../examples/lisp/README.md) sketches a future toy
  compiler example.
- [docs/design.md](design.md) contains broader design notes and historical
  context.
