const fallback = 1;
export type Keys<T extends object> = keyof T;
export type Values<T extends Record<string, unknown>> = T[keyof T];
export type Conditional<T> = T extends Array<infer Item> ? readonly Item[] : typeof fallback;
//# sourceMappingURL=main.ts.map
