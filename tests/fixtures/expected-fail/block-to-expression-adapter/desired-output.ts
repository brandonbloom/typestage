export const expr = (() => {
    const value = compute();
    return value + 1;
})() * 2;
