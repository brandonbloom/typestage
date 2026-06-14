export type Span = {
    end: number;
    start: number;
};
export type LispDiagnostic = {
    code: string;
    message: string;
    span: Span;
};
export type LispExpr = {
    kind: "boolean";
    span: Span;
    value: boolean;
} | {
    kind: "null";
    span: Span;
} | {
    kind: "number";
    span: Span;
    value: number;
} | {
    kind: "string";
    span: Span;
    value: string;
} | {
    kind: "symbol";
    name: string;
    span: Span;
} | {
    items: LispExpr[];
    kind: "list";
    span: Span;
};
export type ParseResult = {
    diagnostics: LispDiagnostic[];
    forms: LispExpr[];
};
type Token = {
    kind: "leftParen" | "rightParen";
    span: Span;
} | {
    kind: "boolean";
    span: Span;
    value: boolean;
} | {
    kind: "null";
    span: Span;
} | {
    kind: "number";
    span: Span;
    value: number;
} | {
    kind: "string";
    span: Span;
    value: string;
} | {
    kind: "symbol";
    name: string;
    span: Span;
};
export function parseProgram(source: string): ParseResult {
    const tokenized = tokenize(source);
    const parser = new Parser(tokenized.tokens, tokenized.diagnostics, source.length);
    return parser.parseProgram();
}
function tokenize(source: string): {
    diagnostics: LispDiagnostic[];
    tokens: Token[];
} {
    const diagnostics: LispDiagnostic[] = [];
    const tokens: Token[] = [];
    let offset = 0;
    while (offset < source.length) {
        const char = source[offset]!;
        if (isWhitespace(char)) {
            offset++;
            continue;
        }
        if (char === ";") {
            while (offset < source.length && source[offset] !== "\n") {
                offset++;
            }
            continue;
        }
        if (char === "(") {
            tokens.push({ kind: "leftParen", span: { start: offset, end: offset + 1 } });
            offset++;
            continue;
        }
        if (char === ")") {
            tokens.push({ kind: "rightParen", span: { start: offset, end: offset + 1 } });
            offset++;
            continue;
        }
        if (char === "\"") {
            const scanned = scanString(source, offset);
            diagnostics.push(...scanned.diagnostics);
            if (scanned.token) {
                tokens.push(scanned.token);
            }
            offset = scanned.end;
            continue;
        }
        const atomStart = offset;
        while (offset < source.length &&
            !isWhitespace(source[offset]!) &&
            source[offset] !== "(" &&
            source[offset] !== ")" &&
            source[offset] !== ";") {
            offset++;
        }
        const text = source.slice(atomStart, offset);
        const span = { start: atomStart, end: offset };
        const number = numberValue(text);
        tokens.push(tokenForAtom(text, span, number));
    }
    return { diagnostics, tokens };
}

function tokenForAtom(text: string, span: Span, number: number | undefined): Token {
    switch (text) {
        case "#true":
            return { kind: "boolean", span, value: true };
        case "#false":
            return { kind: "boolean", span, value: false };
        case "#null":
            return { kind: "null", span };
        default:
            return number === undefined
                ? { kind: "symbol", name: text, span }
                : { kind: "number", value: number, span };
    }
}
function scanString(source: string, start: number): {
    diagnostics: LispDiagnostic[];
    end: number;
    token?: Token;
} {
    const diagnostics: LispDiagnostic[] = [];
    let offset = start + 1;
    let value = "";
    while (offset < source.length) {
        const char = source[offset]!;
        if (char === "\"") {
            return {
                diagnostics,
                end: offset + 1,
                token: {
                    kind: "string",
                    span: { start, end: offset + 1 },
                    value,
                },
            };
        }
        if (char === "\\") {
            const escaped = source[offset + 1];
            if (escaped === undefined) {
                break;
            }
            value += escapeValue(escaped);
            offset += 2;
            continue;
        }
        value += char;
        offset++;
    }
    diagnostics.push({
        code: "LISP1001",
        message: "unterminated string literal",
        span: { start, end: source.length },
    });
    return { diagnostics, end: source.length };
}
function escapeValue(char: string): string {
    switch (char) {
        case "n":
            return "\n";
        case "r":
            return "\r";
        case "t":
            return "\t";
        case "\\":
        case "\"":
            return char;
        default:
            return char;
    }
}
function numberValue(text: string): number | undefined {
    if (!/^-?(?:\d+|\d+\.\d+|\.\d+)$/.test(text)) {
        return undefined;
    }
    return Number(text);
}
function isWhitespace(char: string): boolean {
    return char === " " || char === "\n" || char === "\r" || char === "\t";
}
class Parser {
    private readonly diagnostics: LispDiagnostic[];
    private readonly sourceLength: number;
    private readonly tokens: Token[];
    private index = 0;
    constructor(tokens: Token[], diagnostics: LispDiagnostic[], sourceLength: number) {
        this.tokens = tokens;
        this.diagnostics = [...diagnostics];
        this.sourceLength = sourceLength;
    }
    parseProgram(): ParseResult {
        const forms: LispExpr[] = [];
        while (!this.isAtEnd()) {
            const form = this.parseExpr();
            if (form) {
                forms.push(form);
            }
        }
        return { diagnostics: this.diagnostics, forms };
    }
    private parseExpr(): LispExpr | undefined {
        const token = this.advance();
        if (!token) {
            return undefined;
        }
        switch (token.kind) {
            case "boolean":
                return { kind: "boolean", span: token.span, value: token.value };
            case "null":
                return { kind: "null", span: token.span };
            case "number":
                return { kind: "number", span: token.span, value: token.value };
            case "string":
                return { kind: "string", span: token.span, value: token.value };
            case "symbol":
                return { kind: "symbol", name: token.name, span: token.span };
            case "rightParen":
                this.diagnostics.push({
                    code: "LISP1002",
                    message: "unexpected ')'",
                    span: token.span,
                });
                return undefined;
            case "leftParen":
                return this.parseList(token.span.start);
        }
    }
    private parseList(start: number): LispExpr {
        const items: LispExpr[] = [];
        while (!this.isAtEnd() && this.peek()?.kind !== "rightParen") {
            const item = this.parseExpr();
            if (item) {
                items.push(item);
            }
        }
        const close = this.peek();
        if (close?.kind === "rightParen") {
            this.advance();
            return {
                items,
                kind: "list",
                span: { start, end: close.span.end },
            };
        }
        this.diagnostics.push({
            code: "LISP1003",
            message: "expected ')'",
            span: { start, end: this.sourceLength },
        });
        return {
            items,
            kind: "list",
            span: { start, end: this.sourceLength },
        };
    }
    private advance(): Token | undefined {
        const token = this.tokens[this.index];
        if (token) {
            this.index++;
        }
        return token;
    }
    private isAtEnd(): boolean {
        return this.index >= this.tokens.length;
    }
    private peek(): Token | undefined {
        return this.tokens[this.index];
    }
}
