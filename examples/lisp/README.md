# Tiny Lisp Example

This example is a deliberately small Lisp-shaped compiler built on TypeStage.
It exists to exercise compiler-library workflows, not to be a useful Lisp.

The language has:

- numbers, strings, `#true`, `#false`, and `#null`
- identifiers
- binary `+`, `-`, `*`, and `/`
- function calls
- `(if cond then else)` expressions
- `(do statements... result)` expressions
- `(define name init)` bindings
- `(define (name params...) body...)` functions
- local `(define name init)` statements inside function bodies
- `(print expr)` in statement position
- `(throw expr)` as an expression form

There are no macros, quoting, `let`, arrays, or objects.

## Static Compilation

`static/main.ts` demonstrates the fixture-style model: a TypeStage module
imports the Lisp compiler, embeds a Lisp source string, and exports an outer
`q.decls` quote.

```ts
import {q} from "typestage";
import {compileProgram} from "../src/compiler.ts";

export const program = q.decls`
  ${compileProgram(`
    (define base 10)
    (define (square x) (* x x))
    (define (offsetSquare x)
      (define base 2)
      (+ (square x) base))
    (define result (offsetSquare 4))
    (define (main) (print result))
  `, "examples/lisp/static/program.lisp")}
`;
```

TypeStage compiles that staging module into residual TypeScript declarations.

Local `define` statements update the compiler's lexical environment for later
body forms. In the example above, the `base` inside `offsetSquare` shadows the
top-level `base` only within that generated function.

## CLI

The CLI has two commands:

```sh
bun examples/lisp/src/cli.ts compile examples/lisp/examples/basic.lisp
bun examples/lisp/src/cli.ts compile --source-map -o /tmp/basic.ts examples/lisp/examples/basic.lisp
bun examples/lisp/src/cli.ts repl
```

The REPL compiles one entered Lisp program at a time, prints the generated
TypeScript, evaluates it with Bun, and prints captured output plus the result.
Each input is compiled as its own module. The REPL keeps prior modules in a
hidden namespace and imports those bindings when evaluating later inputs.
If the generated module exports `main`, the REPL calls `main`. Otherwise it
reports the latest generated `resultN`, `result`, or the exported bindings.
Printed values and results are formatted as pretty JSON values. `define` forms
evaluate to `null`.

Example:

```text
lisp> (define (main) (print (+ 1 2)) (* 3 4))
--- TypeScript ---
export function main() {
    console.log((1 + 2));
    return (3 * 4);
}
--- Output ---
3
12
lisp> (define x 1)
--- TypeScript ---
export const x = 1;
--- Output ---
null
lisp> x
--- TypeScript ---
export const result0 = x;
--- Output ---
1
lisp> (if #false 1 #null)
--- TypeScript ---
export const result0 = ((false) ? 1 : (null));
--- Output ---
null
```

Use `:q` or `:quit` to exit.

## Blocks And Expression Adaptation

`(do statements... result)` and `(throw expr)` are intentionally
expression-shaped in Lisp, even though their TypeScript lowerings are
statement-shaped. The compiler lowers them to `q.block` fragments. For example,
`throw` lowers to:

```ts
q.block`
  {
    throw ${value};
  }
`
```

When one of those block forms appears where an expression is required, TypeStage
adapts the block through an IIFE:

```ts
return (() => {
    throw "boom";
})();
```

This demonstrates both statement/expression adaptation and a useful source-map
pressure point.

## Source Maps

The CLI can ask TypeStage for source maps with `--source-map`. The generated
source map points residual TypeScript back to `.lisp` character spans. The
Lisp compiler attaches source origins to the TypeStage runtime fragments it
creates, and `compileRuntimeModule` carries those origins through expansion and
emission.

For example, the generated string literal inside `(throw "boom")` maps back to
the `boom` span in the Lisp source, even though TypeScript receives generated
block and IIFE syntax.
