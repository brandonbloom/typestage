import * as ts from "typescript";
import {unresolvedExplicitSplice} from "./diagnostics/index.ts";
import {isRuntimeCode, type RuntimeCode} from "./runtime.ts";
import type {CodeValue, Diagnostic, ParsedFragment, SpliceHole} from "./types.ts";

export type SpliceValue =
  | {kind: "code"; values: CodeValue[]}
  | {kind: "persistent"; value: unknown}
  | {kind: "missing"};

export type SpliceEvaluatorContext = {
  capturedValues: Map<number, unknown[]>;
  values: Map<number, CodeValue>;
};

export class SpliceEvaluator {
  private readonly codeBindings: Map<string, CodeValue>;
  private readonly context: SpliceEvaluatorContext;
  private readonly diagnostics: Diagnostic[];
  private readonly fragment: ParsedFragment;
  private readonly runtimeValues: unknown[] | undefined;

  constructor(
    context: SpliceEvaluatorContext,
    fragment: ParsedFragment,
    codeBindings: Map<string, CodeValue>,
    runtimeValues: unknown[] | undefined,
    diagnostics: Diagnostic[],
  ) {
    this.codeBindings = codeBindings;
    this.context = context;
    this.diagnostics = diagnostics;
    this.fragment = fragment;
    this.runtimeValues = runtimeValues;
  }

  evaluateSplice(hole: SpliceHole): SpliceValue {
    const captured = capturedValueForHole(
      this.fragment,
      hole,
      this.context.capturedValues,
      this.runtimeValues,
    );

    if (captured.found) {
      return this.evaluateCapturedValue(captured.value, hole);
    }

    const value = codeValueForExpression(
      hole.expression,
      this.codeBindings,
      this.context.values,
    );

    if (value) {
      return {kind: "code", values: [value]};
    }

    this.diagnostics.push({
      code: unresolvedExplicitSplice.code,
      message: `explicit splice '${hole.expression.getText()}' does not resolve to a TypeStage code value`,
      origin: hole.origin,
    });
    return {kind: "missing"};
  }

  evaluateCodeSplice(hole: SpliceHole): CodeValue[] | undefined {
    const captured = capturedValueForHole(
      this.fragment,
      hole,
      this.context.capturedValues,
      this.runtimeValues,
    );

    if (!captured.found) {
      const value = codeValueForExpression(
        hole.expression,
        this.codeBindings,
        this.context.values,
      );

      return value ? [value] : undefined;
    }

    if (isRuntimeCode(captured.value)) {
      const codeValue = codeValueForRuntimeCode(captured.value, this.context.values);

      return codeValue ? [codeValue] : undefined;
    }

    if (!Array.isArray(captured.value)) {
      return undefined;
    }

    const codeValues: CodeValue[] = [];

    for (const item of captured.value) {
      if (!isRuntimeCode(item)) {
        return undefined;
      }

      const codeValue = codeValueForRuntimeCode(item, this.context.values);

      if (!codeValue) {
        return undefined;
      }

      codeValues.push(codeValue);
    }

    return codeValues;
  }

  private evaluateCapturedValue(value: unknown, hole: SpliceHole): SpliceValue {
    if (isRuntimeCode(value)) {
      const codeValue = codeValueForRuntimeCode(value, this.context.values);

      if (codeValue) {
        return {kind: "code", values: [codeValue]};
      }

      this.diagnostics.push({
        code: unresolvedExplicitSplice.code,
        message: `runtime code splice '${hole.expression.getText()}' does not resolve to a static TypeStage quote`,
        origin: hole.origin,
      });
      return {kind: "missing"};
    }

    if (Array.isArray(value) && value.every(isRuntimeCode)) {
      const values: CodeValue[] = [];

      for (const runtimeCode of value) {
        const codeValue = codeValueForRuntimeCode(runtimeCode, this.context.values);

        if (!codeValue) {
          this.diagnostics.push({
            code: unresolvedExplicitSplice.code,
            message: `runtime code splice '${hole.expression.getText()}' does not resolve to a static TypeStage quote`,
            origin: hole.origin,
          });
          return {kind: "missing"};
        }

        values.push(codeValue);
      }

      return {kind: "code", values};
    }

    return {kind: "persistent", value};
  }
}

export function codeValueForExpression(
  expression: ts.Expression,
  codeBindings: Map<string, CodeValue>,
  values: Map<number, CodeValue>,
): CodeValue | undefined {
  if (ts.isIdentifier(expression)) {
    return codeBindings.get(expression.text);
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    for (const value of values.values()) {
      if (value.quote.node === expression) {
        return value;
      }
    }
  }

  return undefined;
}

export function capturedValueForHole(
  fragment: ParsedFragment,
  hole: SpliceHole,
  capturedValues: Map<number, unknown[]>,
  runtimeValues: unknown[] | undefined,
): {
  found: true;
  value: unknown;
} | {
  found: false;
} {
  const values = runtimeValues ?? capturedValues.get(fragment.quote.id);

  return values && hole.index < values.length
    ? {found: true, value: values[hole.index]}
    : {found: false};
}

export function codeValueForRuntimeCode(
  value: RuntimeCode,
  values: Map<number, CodeValue>,
): CodeValue | undefined {
  const codeValue = value.quoteId === undefined ? undefined : values.get(value.quoteId);

  return codeValue
    ? {
      cardinality: codeValue.cardinality,
      kind: codeValue.kind,
      parsed: codeValue.parsed,
      quote: codeValue.quote,
      residualImports: codeValue.residualImports,
      runtimeValues: value.values,
      runtimeHostValues: value.hostValues,
    }
    : undefined;
}
