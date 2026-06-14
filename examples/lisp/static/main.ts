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
    (define (fail) (throw "boom"))
    (define (main)
      (print result)
      (fail))
  `, "examples/lisp/static/program.lisp")}
`;
