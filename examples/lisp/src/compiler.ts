import {q, type RuntimeCode} from "typestage";
import {parseProgram, type LispDiagnostic, type LispExpr, type Span} from "./sexpr.ts";

export type CompileResult = {
  declarations: RuntimeCode[];
  diagnostics: LispDiagnostic[];
};

type CompileContext = {
  diagnostics: LispDiagnostic[];
  globals: Set<string>;
  locals: Map<string, RuntimeCode>;
};

type NamedBinding = {
  name: string;
  span: Span;
};

const arithmeticOperators = new Set(["+", "-", "*", "/"]);

export function compileLisp(
  source: string,
  globals: Iterable<string> = [],
): CompileResult {
  const parsed = parseProgram(source);
  const diagnostics = [...parsed.diagnostics];
  const topLevelNames = new Set(globals);

  for (const form of parsed.forms) {
    const name = topLevelDefineName(form);

    if (name) {
      topLevelNames.add(name);
    }
  }

  const declarations = parsed.forms.flatMap((form, index) =>
    compileTopLevel(form, index, diagnostics, topLevelNames)
  );

  return {
    declarations: diagnostics.length === 0 ? declarations : [],
    diagnostics,
  };
}

export function compileProgram(
  source: string,
  sourceFile = "input.lisp",
  globals: string[] = [],
): RuntimeCode[] {
  const compiled = compileLisp(source, globals);

  if (compiled.diagnostics.length > 0) {
    throw new Error(formatLispDiagnostics(source, sourceFile, compiled.diagnostics));
  }

  return compiled.declarations;
}

export function formatLispDiagnostics(
  source: string,
  sourceFile: string,
  diagnostics: LispDiagnostic[],
): string {
  if (diagnostics.length === 0) {
    return "No Lisp diagnostics.\n";
  }

  return diagnostics
    .map((diagnostic) => {
      const location = locationForOffset(source, diagnostic.span.start);

      return `${sourceFile}:${location.line}:${location.column} ${diagnostic.code}: ${diagnostic.message}`;
    })
    .join("\n") + "\n";
}

function compileTopLevel(
  form: LispExpr,
  index: number,
  diagnostics: LispDiagnostic[],
  globals: Set<string>,
): RuntimeCode[] {
  if (isListNamed(form, "define")) {
    const declaration = compileTopLevelDefine(form, diagnostics, globals);

    return declaration ? [declaration] : [];
  }

  const context: CompileContext = {diagnostics, globals, locals: new Map()};

  if (isListNamed(form, "print")) {
    const statement = compilePrintStatement(form, context);

    return statement ? [statement] : [];
  }

  const expression = compileExpression(form, context);

  if (!expression) {
    return [];
  }

  const resultName = `result${index}`;
  const name = q.ident`${resultName}`;

  return [
    q.decl`
      export const ${name} = ${expression};
    `,
  ];
}

function compileTopLevelDefine(
  form: Extract<LispExpr, {kind: "list"}>,
  diagnostics: LispDiagnostic[],
  globals: Set<string>,
): RuntimeCode | undefined {
  const [, target, ...rest] = form.items;

  if (!target) {
    diagnostics.push({
      code: "LISP2001",
      message: "define expects a binding target",
      span: form.span,
    });
    return undefined;
  }

  if (target.kind === "symbol") {
    return compileTopLevelVariableDefine(target, rest, form.span, diagnostics, globals);
  }

  if (target.kind === "list") {
    return compileFunctionDefine(target, rest, form.span, diagnostics, globals);
  }

  diagnostics.push({
    code: "LISP2002",
    message: "define target must be a symbol or function signature",
    span: target.span,
  });
  return undefined;
}

function compileTopLevelVariableDefine(
  target: Extract<LispExpr, {kind: "symbol"}>,
  rest: LispExpr[],
  span: Span,
  diagnostics: LispDiagnostic[],
  globals: Set<string>,
): RuntimeCode | undefined {
  const [initExpr, extra] = rest;

  if (!initExpr || extra) {
    diagnostics.push({
      code: "LISP2003",
      message: "variable define expects exactly one initializer",
      span,
    });
    return undefined;
  }

  const context: CompileContext = {diagnostics, globals, locals: new Map()};
  const name = identifier(target.name, target.span, diagnostics);
  const init = compileExpression(initExpr, context);

  return name && init
    ? q.decl`export const ${name} = ${init};`
    : undefined;
}

function compileFunctionDefine(
  signature: Extract<LispExpr, {kind: "list"}>,
  body: LispExpr[],
  span: Span,
  diagnostics: LispDiagnostic[],
  globals: Set<string>,
): RuntimeCode | undefined {
  const [nameExpr, ...paramExprs] = signature.items;

  if (!nameExpr || body.length === 0) {
    diagnostics.push({
      code: "LISP2004",
      message: "function define expects a signature and body",
      span,
    });
    return undefined;
  }

  const name = symbolName(nameExpr, diagnostics, "function name");
  const params = parameterNames(paramExprs, diagnostics);

  if (!name || !params) {
    return undefined;
  }

  const functionName = identifier(name, nameExpr.span, diagnostics);
  const parameterIdentifiers = params.map((param) =>
    q.ident`${param.name}: any`
  );
  const locals = new Map<string, RuntimeCode>();

  for (const [index, param] of params.entries()) {
    locals.set(param.name, parameterIdentifiers[index]!);
  }

  const context: CompileContext = {diagnostics, globals, locals};
  const statements = compileFunctionBody(body, context);

  if (!functionName || !statements) {
    return undefined;
  }

  return q.decl`
    export function ${functionName}(${parameterIdentifiers}) {
      ${statements}
    }
  `;
}

function compileFunctionBody(
  body: LispExpr[],
  context: CompileContext,
): RuntimeCode | undefined {
  const statements: RuntimeCode[] = [];

  for (const [index, form] of body.entries()) {
    const isLast = index === body.length - 1;
    const statement = compileBodyStatement(form, isLast, context);

    if (statement) {
      statements.push(statement);
    }
  }

  return context.diagnostics.length === 0
    ? q.stmts`
      ${statements}
    `
    : undefined;
}

function compileBodyStatement(
  form: LispExpr,
  isLast: boolean,
  context: CompileContext,
): RuntimeCode | undefined {
  if (isListNamed(form, "define")) {
    return compileLocalDefine(form, context);
  }

  if (isListNamed(form, "print")) {
    return compilePrintStatement(form, context);
  }

  if (isListNamed(form, "do")) {
    return compileDoStatement(form, isLast, context);
  }

  const expression = compileExpression(form, context);

  if (!expression) {
    return undefined;
  }

  return isLast
    ? q.stmt`return ${expression};`
    : q.stmt`${expression};`;
}

function compileDoStatement(
  form: Extract<LispExpr, {kind: "list"}>,
  isLast: boolean,
  context: CompileContext,
): RuntimeCode | undefined {
  const block = compileDoBlock(form, context);

  if (!block) {
    return undefined;
  }

  return isLast
    ? q.stmt`return ${block};`
    : q.stmt`${block};`;
}

function compileLocalDefine(
  form: Extract<LispExpr, {kind: "list"}>,
  context: CompileContext,
): RuntimeCode | undefined {
  const [, target, initExpr, extra] = form.items;

  if (!target || !initExpr || extra) {
    context.diagnostics.push({
      code: "LISP2005",
      message: "local define expects a name and initializer",
      span: form.span,
    });
    return undefined;
  }

  if (target.kind !== "symbol") {
    context.diagnostics.push({
      code: "LISP2006",
      message: "local define target must be a symbol",
      span: target.span,
    });
    return undefined;
  }

  if (context.locals.has(target.name)) {
    context.diagnostics.push({
      code: "LISP2007",
      message: `duplicate lexical binding '${target.name}'`,
      span: target.span,
    });
    return undefined;
  }

  const init = compileExpression(initExpr, context);
  const name = identifier(target.name, target.span, context.diagnostics);

  if (!name || !init) {
    return undefined;
  }

  context.locals.set(target.name, name);

  return q.stmt`const ${name} = ${init};`;
}

function compilePrintStatement(
  form: Extract<LispExpr, {kind: "list"}>,
  context: CompileContext,
): RuntimeCode | undefined {
  const [, value, extra] = form.items;

  if (!value || extra) {
    context.diagnostics.push({
      code: "LISP2008",
      message: "print expects exactly one argument",
      span: form.span,
    });
    return undefined;
  }

  const expression = compileExpression(value, context);

  return expression
    ? q.stmt`console.log(${expression});`
    : undefined;
}

function compileExpression(
  form: LispExpr,
  context: CompileContext,
): RuntimeCode | undefined {
  switch (form.kind) {
    case "boolean":
      return q.expr`${form.value}`;

    case "null":
      return q.expr`${null}`;

    case "number":
      return q.expr`${form.value}`;

    case "string":
      return q.expr`${form.value}`;

    case "symbol":
      return compileSymbolReference(form, context);

    case "list":
      return compileCallExpression(form, context);
  }
}

function compileCallExpression(
  form: Extract<LispExpr, {kind: "list"}>,
  context: CompileContext,
): RuntimeCode | undefined {
  const [head, ...args] = form.items;

  if (!head) {
    context.diagnostics.push({
      code: "LISP2009",
      message: "empty list is not an expression",
      span: form.span,
    });
    return undefined;
  }

  if (head.kind !== "symbol") {
    context.diagnostics.push({
      code: "LISP2010",
      message: "list head must be a symbol",
      span: head.span,
    });
    return undefined;
  }

  if (arithmeticOperators.has(head.name)) {
    return compileArithmetic(head.name, args, form.span, context);
  }

  if (head.name === "throw") {
    return compileThrowExpression(args, form.span, context);
  }

  if (head.name === "if") {
    return compileIfExpression(args, form.span, context);
  }

  if (head.name === "do") {
    return compileDoBlock(form, context);
  }

  if (head.name === "print") {
    context.diagnostics.push({
      code: "LISP2011",
      message: "print is only valid in statement position",
      span: form.span,
    });
    return undefined;
  }

  if (head.name === "define") {
    context.diagnostics.push({
      code: "LISP2012",
      message: "define is only valid in statement position",
      span: form.span,
    });
    return undefined;
  }

  if (!context.globals.has(head.name) && !context.locals.has(head.name)) {
    context.diagnostics.push({
      code: "LISP2020",
      message: `unknown symbol '${head.name}'`,
      span: head.span,
    });
    return undefined;
  }

  const callee = identifier(head.name, head.span, context.diagnostics);
  const compiledArgs = args.map((arg) => compileExpression(arg, context));

  if (!callee || compiledArgs.some((arg) => !arg)) {
    return undefined;
  }

  return q.expr`${callee}(${compiledArgs})`;
}

function compileIfExpression(
  args: LispExpr[],
  span: Span,
  context: CompileContext,
): RuntimeCode | undefined {
  const [conditionExpr, thenExpr, elseExpr, extra] = args;

  if (!conditionExpr || !thenExpr || !elseExpr || extra) {
    context.diagnostics.push({
      code: "LISP2013",
      message: "if expects exactly three arguments",
      span,
    });
    return undefined;
  }

  const condition = compileExpression(conditionExpr, context);
  const thenBranch = compileExpression(thenExpr, context);
  const elseBranch = compileExpression(elseExpr, context);

  return condition && thenBranch && elseBranch
    ? q.expr`${condition} ? ${thenBranch} : ${elseBranch}`
    : undefined;
}

function compileDoBlock(
  form: Extract<LispExpr, {kind: "list"}>,
  context: CompileContext,
): RuntimeCode | undefined {
  const [, ...body] = form.items;

  if (body.length === 0) {
    context.diagnostics.push({
      code: "LISP2014",
      message: "do expects at least one body form",
      span: form.span,
    });
    return undefined;
  }

  const localContext: CompileContext = {
    diagnostics: context.diagnostics,
    locals: new Map(context.locals),
  };
  const statements: RuntimeCode[] = [];

  for (const [index, bodyForm] of body.entries()) {
    const isLast = index === body.length - 1;

    if (isLast) {
      const expression = compileExpression(bodyForm, localContext);

      if (expression) {
        statements.push(q.stmt`return ${expression};`);
      }
    } else {
      const statement = compileBodyStatement(bodyForm, false, localContext);

      if (statement) {
        statements.push(statement);
      }
    }
  }

  if (localContext.diagnostics.length > 0) {
    return undefined;
  }

  return q.expr`(() => {
    ${q.stmts`${statements}`}
  })()`;
}

function compileArithmetic(
  operator: string,
  args: LispExpr[],
  span: Span,
  context: CompileContext,
): RuntimeCode | undefined {
  const [leftExpr, rightExpr, extra] = args;

  if (!leftExpr || !rightExpr || extra) {
    context.diagnostics.push({
      code: "LISP2015",
      message: `'${operator}' expects exactly two arguments`,
      span,
    });
    return undefined;
  }

  const left = compileExpression(leftExpr, context);
  const right = compileExpression(rightExpr, context);

  if (!left || !right) {
    return undefined;
  }

  switch (operator) {
    case "+":
      return q.expr`${left} + ${right}`;

    case "-":
      return q.expr`${left} - ${right}`;

    case "*":
      return q.expr`${left} * ${right}`;

    case "/":
      return q.expr`${left} / ${right}`;

    default:
      return undefined;
  }
}

function compileThrowExpression(
  args: LispExpr[],
  span: Span,
  context: CompileContext,
): RuntimeCode | undefined {
  const [valueExpr, extra] = args;

  if (!valueExpr || extra) {
    context.diagnostics.push({
      code: "LISP2016",
      message: "throw expects exactly one argument",
      span,
    });
    return undefined;
  }

  const value = compileExpression(valueExpr, context);

  return value
    ? q.block`
      {
        throw ${value};
      }
    `
    : undefined;
}

function compileSymbolReference(
  form: Extract<LispExpr, {kind: "symbol"}>,
  context: CompileContext,
): RuntimeCode | undefined {
  const local = context.locals.get(form.name);

  if (local) {
    return q.expr`${local}`;
  }

  if (!context.globals.has(form.name)) {
    context.diagnostics.push({
      code: "LISP2020",
      message: `unknown symbol '${form.name}'`,
      span: form.span,
    });
    return undefined;
  }

  const name = identifier(form.name, form.span, context.diagnostics);

  return name ? q.expr`${name}` : undefined;
}

function topLevelDefineName(form: LispExpr): string | undefined {
  if (!isListNamed(form, "define")) {
    return undefined;
  }

  const target = form.items[1];

  if (target?.kind === "symbol") {
    return target.name;
  }

  if (target?.kind === "list") {
    const name = target.items[0];

    return name?.kind === "symbol" ? name.name : undefined;
  }

  return undefined;
}

function identifier(
  name: string,
  span: Span,
  diagnostics: LispDiagnostic[],
): RuntimeCode | undefined {
  if (!isTypeScriptIdentifier(name)) {
    diagnostics.push({
      code: "LISP2017",
      message: `'${name}' is not a valid TypeScript identifier`,
      span,
    });
    return undefined;
  }

  return q.ident`${name}`;
}

function parameterNames(
  forms: LispExpr[],
  diagnostics: LispDiagnostic[],
): NamedBinding[] | undefined {
  const params: NamedBinding[] = [];
  const seen = new Set<string>();

  for (const item of forms) {
    const name = symbolName(item, diagnostics, "parameter");

    if (!name) {
      continue;
    }

    if (seen.has(name)) {
      diagnostics.push({
        code: "LISP2018",
        message: `duplicate parameter '${name}'`,
        span: item.span,
      });
      continue;
    }

    seen.add(name);
    params.push({name, span: item.span});
  }

  return params;
}

function symbolName(
  form: LispExpr,
  diagnostics: LispDiagnostic[],
  role: string,
): string | undefined {
  if (form.kind === "symbol") {
    return form.name;
  }

  diagnostics.push({
    code: "LISP2019",
    message: `${role} must be a symbol`,
    span: form.span,
  });
  return undefined;
}

function isListNamed(
  form: LispExpr,
  name: string,
): form is Extract<LispExpr, {kind: "list"}> {
  const head = form.kind === "list" ? form.items[0] : undefined;

  return head?.kind === "symbol" && head.name === name;
}

function isTypeScriptIdentifier(name: string): boolean {
  return /^[$A-Z_a-z][$\w]*$/.test(name);
}

function locationForOffset(source: string, offset: number): {
  column: number;
  line: number;
} {
  let line = 1;
  let column = 1;

  for (let index = 0; index < offset && index < source.length; index++) {
    if (source[index] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }

  return {column, line};
}
