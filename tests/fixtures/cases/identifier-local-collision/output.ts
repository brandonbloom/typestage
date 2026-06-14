export function run() {
    const tmp = "outer";
    const tmp_1 = compute();
    use(tmp_1);
    return tmp;
}
