export const expr = ((() => {
    const bag = { rhs: 1 };
    const { rhs } = bag;
    return rhs;
})());
