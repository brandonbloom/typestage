# TypeStage: Syntactic Staging for TypeScript

## Summary

TypeStage is a syntactic staged metaprogramming system for TypeScript inspired by the staged metaprogramming literature, including systems such as MetaOCaml, Terra, and MetaCLJ. It provides quotation, splicing, implicit unquoting, lexical-environment-aware code values, and phase-aware binding analysis while remaining valid TypeScript source code.

The goal is to bring multi-stage programming techniques to the TypeScript ecosystem without extending TypeScript syntax or implementing a TypeScript typechecker.

TypeStage programs are ordinary TypeScript files containing recognized quote forms imported from the TypeStage runtime:

```ts
import { q } from "typestage";

const expr = q.expr`x + 1`;

const stmt = q.stmt`
  if (${test}) {
    ${body}
  }
`;
```

A TypeStage compiler analyzes these quote forms, parses their template contents as TypeScript fragments, resolves bindings across quote/splice boundaries, expands implicit unquotes, and emits ordinary TypeScript or JavaScript plus source maps.

## Goals

TypeStage should:

* Remain syntactically valid TypeScript.
* Support staged code construction using explicit quote forms.
* Support explicit splicing through template interpolation.
* Support implicit unquoting of code-valued bindings.
* Preserve lexical binding information inside code values.
* Understand TypeScript binding constructs without implementing TypeScript’s full type system.
* Emit ordinary TypeScript or JavaScript.
* Produce source maps suitable for downstream tooling.
* Interoperate with existing TypeScript build tools as much as possible.
* Support compiler construction and code generation workflows.

## Non-goals

TypeStage does not initially aim to:

* Implement TypeScript typechecking.
* Add new syntax to TypeScript.
* Require typed `Code<T>` as a semantic foundation.
* Replace `tsc`, `swc`, `esbuild`, or Babel.
* Preserve every formatting detail in the first implementation.
* Support every TypeScript/JSX construct on day one.
* Introduce a new type system for staged code.

## Quote Forms

TypeStage uses tagged-template quote forms imported from the TypeStage runtime:

```ts
import { q } from "typestage";

q.expr`x + y`
q.stmt`return ${expr};`
q.block`{ ${stmts} }`
q.decl`const x = ${init};`
q.module`
  import { foo } from "foo";
  ${decls}
`
q.type`Array<${T}>`
q.pattern`{ x, y }`
```

The suffix identifies the TypeScript grammar entry point used to parse the quoted fragment.

This avoids ambiguity: the same text may be valid as an expression, statement, declaration, type, pattern, or module item depending on context.

## Code Values

A quote form produces a TypeStage code value.

A code value contains:

```ts
type Code = {
  kind: FragmentKind;
  ast: TypeStageAst;
  lexicalEnv: LexicalEnvironment;
  sourceMapInfo: SourceMapInfo;
};
```

The TypeScript-level runtime representation is implementation-defined. Semantically, however, a code value is not just a string. It is syntax plus its lexical environment.

A binding may be known by the TypeStage compiler to hold code even if TypeScript’s type system does not encode that fact. “Codeness” is a static property of the binding in the TypeStage expander environment, not necessarily a TypeScript type.

## Explicit Splicing

Template interpolations are explicit splices:

```ts
const expr = q.expr`x + 1`;

const stmt = q.stmt`
  const y = ${expr};
`;
```

The contents of `${...}` are ordinary host TypeScript expressions. They are parsed by the TypeScript parser as normal code.

Conceptually:

* Entering a quote enters a residual-code context.
* Entering a splice returns to the enclosing host context.
* The splice expression is evaluated or interpreted in the enclosing context.
* The result is inserted into the quoted syntax.

## Implicit Unquoting

TypeStage supports implicit unquoting of code-valued bindings:

```ts
const x = q.ident`x`;
const y = q.ident`y`;
const rhs = q.expr`y + 1`;

const expr = q.expr`
  x + rhs
`;
```

If `x`, `y`, or `rhs` resolve to host bindings known to contain code, then they are implicitly spliced into the quote.

Implicit unquoting follows ordinary lexical shadowing rules:

```ts
const x = q.expr`foo`;

const expr = q.expr`
  let x = 1;
  x
`;
```

Here the inner `x` resolves to the quoted local binding, not the outer code-valued binding.

Resolution order inside quotes:

1. Resolve against local quoted bindings.
2. Resolve against enclosing quoted bindings.
3. If unresolved in the residual environment, check enclosing host bindings.
4. If a matching host binding is code-valued and compatible with the current syntactic position, implicitly unquote it.
5. If a matching host binding is an import, capture it as a residual import dependency.
6. If a matching host binding is value-valued, persist its staging-time value.
7. If TypeScript resolves the name as an ambient value or type from the configured `lib`, `types`, or `.d.ts` environment, leave it as a residual reference.
8. Otherwise report an unresolved residual reference.

Imported values are residual names by default. If residual code references an
imported function or value, TypeStage emits the corresponding import with the
generated code, even when the quote is imported and emitted from another module.
Use an explicit splice such as `${settings}` when you want the staging-time
snapshot of an imported value instead.

## Binding Analysis

TypeStage requires a syntactic binder, not a TypeScript typechecker.

The binder maps declarations and references across TypeScript syntax:

```ts
syntax tree -> scopes -> declarations -> references -> resolved bindings
```

It must understand ordinary TypeScript binding constructs, including:

```ts
import { x as y } from "m";
const { a: [b, ...c] } = obj;
for (const [k, v] of entries) {}
function f<T>(x: T) {}
class C { #p; method(x) {} }
try {} catch (e) {}
```

It must also account for TypeScript’s distinct binding spaces, at least:

* value bindings
* type bindings
* namespace bindings
* private names
* labels
* possibly JSX-specific names

### Hoisting

JavaScript and TypeScript hoisting complicate binding analysis.

Unlike Clojure, where lexical binding analysis is largely local and explicit, JavaScript contains declaration forms whose visibility extends beyond their textual position:

```ts
foo();

function foo() {}
```

```ts
console.log(x);
var x = 1;
```

TypeStage's binder must model JavaScript's actual binding semantics rather than relying solely on textual ordering.

Fortunately, this remains substantially simpler than implementing TypeScript typechecking. The binder does not need assignability, inference, overload resolution, conditional types, control-flow narrowing, declaration emit, or full module resolution. It only needs to construct scopes and resolve references according to JavaScript and TypeScript binding rules.

A practical implementation will likely mirror the binding phase already present in the TypeScript compiler, while ignoring most of the subsequent typechecking machinery.

## Staging Model

TypeStage distinguishes between host code and residual code.

The staged metaprogramming literature often describes this using numbered stages or levels. A quote moves into a deeper stage; a splice returns to an enclosing stage.

For example:

```ts
q.expr`
  x + ${y}
`;
```

The quoted body is residual code. The splice expression `y` is evaluated in the enclosing host context.

Nested quotation is also possible:

```ts
q.expr`
  foo(${q.expr`bar`})
`;
```

A useful implementation may internally represent these contexts using stage numbers, but stage numbering is not intended as a user-facing concept.

The purpose of stage levels is simply to answer questions such as:

* Which bindings are visible here?
* Is this name a residual reference or a host reference?
* Does this identifier refer to code or to a runtime value?
* Which lexical environment should be attached to a code value?

The exact internal representation remains an implementation detail.

## Hygiene and Lexical Environments

Code values retain lexical environments. This allows TypeStage to distinguish accidental name equality from intentional binding capture.

For example:

```ts
const tmp = q.expr`x`;

function wrap(body) {
  return q.expr`
    (() => {
      const x = 1;
      return body;
    })()
  `;
}
```

If `body` implicitly unquotes, its free references should resolve according to the lexical environment attached to the code value, not merely by textual insertion.

This is the key distinction between TypeStage and string-based code generation.

## Fragment Compatibility

Each quote and splice has a fragment kind:

```ts
expr
stmt
block
decl
module
type
pattern
```

Splicing must respect syntactic position.

Examples:

```ts
const e = q.expr`x + 1`;
q.stmt`return ${e};`; // valid

const s = q.stmt`return x;`;
q.expr`${s} + 1`; // invalid
```

However, TypeStage should support a limited set of automatic adapters where the transformation is well-defined.

For example, a statement fragment may sometimes be adapted into an expression using an IIFE:

```ts
const s = q.stmt`
  const x = 1;
  return x + 2;
`;

const e = adapt.expr(s);
```

Conceptually:

```ts
(() => {
  const x = 1;
  return x + 2;
})()
```

Such adaptations must be conservative. Constructs whose semantics depend on surrounding lexical structure may not be safely adaptable:

```ts
break;
continue;
yield;
await;
```

TypeStage should perform syntactic analysis to detect these cases and reject invalid adaptations rather than silently generating incorrect code.

Some fragment kinds may support sequence splicing:

```ts
const stmts = q.stmts`
  const x = 1;
  const y = 2;
`;

q.block`
  {
    ${stmts}
    return x + y;
  }
`;
```

The exact fragment taxonomy can evolve, but explicit fragment kinds should be preferred over one overloaded quote form.

## Tooling Strategy

Because TypeStage source is syntactically valid TypeScript, existing editors, formatters, linters, and build tools can parse the host file.

The quoted template bodies are opaque to standard TypeScript tooling, but TypeStage can provide tooling support by generating virtual TypeScript files and source maps.

The compiler pipeline:

1. Parse the host file using the TypeScript parser.
2. Find recognized quote forms.
3. Parse template bodies as TypeScript fragments with splice holes.
4. Run TypeStage binding analysis.
5. Expand explicit and implicit unquotes.
6. Emit residual TypeScript or JavaScript.
7. Emit source maps back to the original source.

This is similar in spirit to how systems such as Svelte generate TypeScript-shaped intermediate code and map diagnostics back to source.

## Module Semantics

A TypeStage file is both a program and a code generator.

The top level of a TypeStage module executes in the host environment. After execution completes, the module's exports are treated as the generated program.

Conceptually:

```ts
import { q } from "typestage";

export const add = q.decl`
  export function add(a: number, b: number) {
    return a + b;
  }
`;
```

behaves similarly to:

```ts
saveModule(exports);
```

where the exported code values are collected, assembled into a module, tree-shaken, and emitted as ordinary TypeScript.

This model is inspired by Terra's `terralib.saveobj`, which allows staged programs to generate and save compiled artifacts.

TypeStage should provide a corresponding facility for emitting TypeScript modules together with source maps. This capability is particularly attractive for compiler construction, code generators, DSL implementations, and build-time specialization.

The exact API remains open, but the default behavior of a TypeStage module should be conceptually equivalent to applying a `saveModule` operation to its exports.

## Compiler Architecture

Suggested components:

```txt
Host Parser
  -> Quote Extractor
  -> Fragment Parser
  -> Binder
  -> Stage Resolver
  -> Expander
  -> Residualizer
  -> Printer
  -> Source Map Generator
```

### Host Parser

Uses the TypeScript parser to parse the outer file.

### Quote Extractor

Recognizes forms such as:

```ts
q.expr`...`
q.stmt`...`
q.decl`...`
```

### Fragment Parser

Parses template contents into TypeStage ASTs with hole nodes representing `${...}` interpolations.

### Binder

Builds lexical scopes for host code and quoted fragments.

### Stage Resolver

Resolves names according to binding space, lexical scope, and staging context.

### Expander

Performs explicit splicing and implicit unquoting.

### Residualizer

Converts staged ASTs into ordinary TypeScript ASTs.

### Printer

Emits ordinary TypeScript or JavaScript.

### Source Map Generator

Maps generated code and diagnostics back to original TypeStage source.

## Example

Input:

```ts
import { q } from "typestage";

const rhs = q.expr`y + 1`;

const expr = q.expr`
  x + rhs
`;
```

TypeStage recognizes that `rhs` is a code-valued host binding. Inside the quote, `rhs` is not locally bound, so it is implicitly unquoted.

Equivalent conceptual output:

```ts
const expr = q.expr`
  x + (y + 1)
`;
```

But the actual expansion preserves lexical identity, not just text.

## Future Directions

### Exotypes

Terra's exotype system demonstrates one possible approach to integrating staged code generation with type-level abstractions.

Exotypes are explicitly out of scope for the initial TypeStage design. TypeStage should first establish a robust syntactic staging model independent of TypeScript's type system.

However, exotype-like mechanisms may become interesting in the future as a way to connect generated code, type information, and staged abstractions.

### Artifact Generation

Terra's `terralib.saveobj` is one of the most compelling ideas in the staged programming ecosystem.

TypeStage should eventually support first-class artifact generation APIs capable of emitting:

* TypeScript source
* JavaScript source
* declaration files
* source maps
* bundles of generated modules

This would make TypeStage a practical foundation for compiler construction and large-scale code generation systems.

## Open Questions

* What is the minimal useful set of fragment kinds?
* Should implicit unquote be enabled by default or opt-in per quote form?
* How should intentional capture be expressed?
* How should generated identifiers be represented?
* Should TypeStage expose a public `Code` runtime API?
* Should the first compiler emit TypeScript source, JavaScript source, or TypeScript AST?
* How much JSX support is needed initially?
* How should source maps represent positions inside template literals?
* Should TypeStage integrate with `tsserver` directly, or start with a standalone CLI and generated virtual files?
* What should the exact semantics of module emission and export collection be?
* Which automatic fragment adapters are safe and useful?

## Initial MVP

A plausible MVP:

* Support `.ts` files only, no JSX.
* Require `import { q } from "typestage"`.
* Support `q.expr`, `q.stmt`, `q.block`, and `q.decl`.
* Support explicit splicing.
* Support implicit unquoting for expression code.
* Implement lexical binding for common declarations, imports, functions, blocks, classes, destructuring, and hoisting.
* Emit TypeScript.
* Emit basic source maps.
* Support export-driven module generation.
* Defer type-space staging, JSX, declaration merging, exotypes, and advanced formatting.

The MVP should prove the core idea: TypeStage can provide staged metaprogramming for TypeScript while remaining valid TypeScript and avoiding a custom TypeScript typechecker.
