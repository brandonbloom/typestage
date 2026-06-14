/**
 * Multi-stage persistence serializer.
 * Converts supported staging-time runtime values into residual TypeScript
 * expressions and rejects values whose identity, behavior, or object shape
 * cannot be represented by the minimal persistence model.
 */
import * as ts from "typescript";

/** Result of converting a runtime value into residual TypeScript syntax. */
export type PersistenceResult = {
  expression: ts.Expression;
  ok: true;
} | {
  message: string;
  ok: false;
};

/** Converts a supported runtime value into a residual TypeScript expression. */
export function persistValueToExpression(value: unknown): PersistenceResult {
  return persistValue(value, new WeakSet<object>());
}

function persistValue(value: unknown, seen: WeakSet<object>): PersistenceResult {
  if (value === undefined) {
    return ok(ts.factory.createIdentifier("undefined"));
  }

  if (value === null) {
    return ok(ts.factory.createNull());
  }

  switch (typeof value) {
    case "boolean":
      return ok(value ? ts.factory.createTrue() : ts.factory.createFalse());

    case "bigint":
      return ok(ts.factory.createBigIntLiteral(`${value.toString()}n`));

    case "number":
      return persistNumber(value);

    case "string":
      return ok(ts.factory.createStringLiteral(value));

    case "function":
      return unsupported("function values cannot be persisted");

    case "symbol":
      return persistSymbol(value);

    case "object":
      return persistObject(value, seen);
  }

  return unsupported(`values of type ${typeof value} cannot be persisted`);
}

function persistSymbol(value: symbol): PersistenceResult {
  const key = Symbol.keyFor(value);

  return key === undefined
    ? unsupported("local symbol values cannot be persisted")
    : ok(
        ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier("Symbol"),
            "for",
          ),
          undefined,
          [ts.factory.createStringLiteral(key)],
        ),
      );
}

function persistNumber(value: number): PersistenceResult {
  if (Number.isNaN(value)) {
    return ok(ts.factory.createIdentifier("NaN"));
  }

  if (value === Infinity) {
    return ok(ts.factory.createIdentifier("Infinity"));
  }

  if (value === -Infinity) {
    return ok(prefixMinus(ts.factory.createIdentifier("Infinity")));
  }

  if (Object.is(value, -0)) {
    return ok(prefixMinus(ts.factory.createNumericLiteral(0)));
  }

  return ok(ts.factory.createNumericLiteral(value));
}

function persistObject(value: object, seen: WeakSet<object>): PersistenceResult {
  if (seen.has(value)) {
    return unsupported("cyclic or shared object identity cannot be persisted");
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return persistArray(value, seen);
  }

  if (value instanceof Date) {
    return ok(
      ts.factory.createNewExpression(
        ts.factory.createIdentifier("Date"),
        undefined,
        [
          Number.isNaN(value.getTime())
            ? ts.factory.createIdentifier("NaN")
            : ts.factory.createStringLiteral(value.toISOString()),
        ],
      ),
    );
  }

  if (value instanceof RegExp) {
    return ok(ts.factory.createRegularExpressionLiteral(value.toString()));
  }

  if (value instanceof Map) {
    return persistMap(value, seen);
  }

  if (value instanceof Set) {
    return persistSet(value, seen);
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return unsupported("ArrayBuffer and typed array values cannot be persisted");
  }

  if (value instanceof Error) {
    return unsupported("Error values cannot be persisted");
  }

  const prototype = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null) {
    return unsupported("class instances cannot be persisted");
  }

  return persistPlainObject(value as Record<string, unknown>, seen);
}

function persistArray(
  value: readonly unknown[],
  seen: WeakSet<object>,
): PersistenceResult {
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) {
      return unsupported("sparse arrays cannot be persisted");
    }
  }

  const propertyCheck = validateOwnDataProperties(value, ["length"]);

  if (!propertyCheck.ok) {
    return propertyCheck;
  }

  const elements: ts.Expression[] = [];

  for (const element of value) {
    const persisted = persistValue(element, seen);

    if (!persisted.ok) {
      return persisted;
    }

    elements.push(persisted.expression);
  }

  return ok(ts.factory.createArrayLiteralExpression(elements, false));
}

function persistPlainObject(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
): PersistenceResult {
  const propertyCheck = validateOwnDataProperties(value);

  if (!propertyCheck.ok) {
    return propertyCheck;
  }

  const properties: ts.ObjectLiteralElementLike[] = [];

  for (const key of Object.keys(value)) {
    const persisted = persistValue(value[key], seen);

    if (!persisted.ok) {
      return persisted;
    }

    properties.push(
      ts.factory.createPropertyAssignment(propertyName(key), persisted.expression),
    );
  }

  return ok(ts.factory.createObjectLiteralExpression(properties, true));
}

function persistMap(
  value: Map<unknown, unknown>,
  seen: WeakSet<object>,
): PersistenceResult {
  const entries: ts.Expression[] = [];

  for (const [key, entryValue] of value) {
    const persistedKey = persistValue(key, seen);

    if (!persistedKey.ok) {
      return persistedKey;
    }

    const persistedValue = persistValue(entryValue, seen);

    if (!persistedValue.ok) {
      return persistedValue;
    }

    entries.push(
      ts.factory.createArrayLiteralExpression(
        [persistedKey.expression, persistedValue.expression],
        false,
      ),
    );
  }

  return ok(
    ts.factory.createNewExpression(
      ts.factory.createIdentifier("Map"),
      undefined,
      [ts.factory.createArrayLiteralExpression(entries, true)],
    ),
  );
}

function persistSet(
  value: Set<unknown>,
  seen: WeakSet<object>,
): PersistenceResult {
  const values: ts.Expression[] = [];

  for (const entry of value) {
    const persisted = persistValue(entry, seen);

    if (!persisted.ok) {
      return persisted;
    }

    values.push(persisted.expression);
  }

  return ok(
    ts.factory.createNewExpression(
      ts.factory.createIdentifier("Set"),
      undefined,
      [ts.factory.createArrayLiteralExpression(values, true)],
    ),
  );
}

function validateOwnDataProperties(
  value: object,
  ignoredKeys: string[] = [],
): PersistenceResult {
  const ignored = new Set<PropertyKey>(ignoredKeys);
  const enumerableKeys = new Set(Object.keys(value));

  for (const key of Reflect.ownKeys(value)) {
    if (ignored.has(key)) {
      continue;
    }

    if (typeof key === "symbol") {
      return unsupported("objects with symbol keys cannot be persisted");
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (!descriptor || descriptor.get || descriptor.set) {
      return unsupported("objects with accessors cannot be persisted");
    }

    if (!descriptor.enumerable || !enumerableKeys.has(key)) {
      return unsupported("objects with non-enumerable properties cannot be persisted");
    }
  }

  return ok(ts.factory.createIdentifier("undefined"));
}

function propertyName(key: string): ts.PropertyName {
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(key)
    ? ts.factory.createIdentifier(key)
    : ts.factory.createStringLiteral(key);
}

function prefixMinus(expression: ts.Expression): ts.PrefixUnaryExpression {
  return ts.factory.createPrefixUnaryExpression(
    ts.SyntaxKind.MinusToken,
    expression,
  );
}

function ok(expression: ts.Expression): PersistenceResult {
  return {expression, ok: true};
}

function unsupported(message: string): PersistenceResult {
  return {message, ok: false};
}
