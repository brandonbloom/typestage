export function run() {
    const tmp = "outer";
    const tmp = compute();
    use(tmp);
    return tmp;
}
