# Lisp Example TODO

This directory is reserved for a small Lisp-like language compiler built with
TypeStage. The point is not to create a serious Lisp, but to exercise the API
surface TypeStage should offer to libraries that want to build compilers,
DSLs, and staged code generators.

Terra's API suggests several compiler-construction affordances that are more
library-shaped than core syntax-shaped: parser integration, explicit binding
objects, code reflection, diagnostic remapping, and source-map-aware residual
type errors. A tiny Lisp gives us a compact place to test those ideas together.

## Sketch

The language should stay deliberately small:

- literals: numbers, strings, booleans
- identifiers
- arithmetic forms such as `(+ a b)` and `(* a b)`
- `let` bindings
- `if`
- function declarations such as `(defn square (x) (* x x))`
- function calls

The compiler should lower Lisp forms to TypeStage fragments, then rely on
TypeStage to emit residual TypeScript.

## TODO

- Parse Lisp source and report parser diagnostics with source locations.
- Generate `q.expr` and `q.decl` fragments from Lisp AST nodes.
- Use future explicit identifier/binding APIs for hygienic `let` bindings and
  function parameters.
- Preserve source origins so generated TypeScript source maps point back to
  Lisp forms.
- Remap residual TypeScript type errors back to Lisp source locations.
- Add fixture tests that snapshot Lisp input, generated TypeScript, source
  maps, and remapped diagnostics.
- Keep the language tiny enough that each feature exists to illuminate
  TypeStage's compiler-building API, not to make a production language.
