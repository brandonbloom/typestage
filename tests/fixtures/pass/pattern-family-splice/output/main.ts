export const collect: (first: number, second: number, record: {
    third: number;
}) => number[] = function (first, second, { third }) {
    return [first, second, third];
};
