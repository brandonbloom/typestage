export const expr = (configure({
    values: [undefined, NaN, Infinity, -Infinity, -0, 1n],
    nested: {
        ok: true
    },
    set: new Set([
        "a",
        "b"
    ]),
    pattern: /ab+/gi
}));
