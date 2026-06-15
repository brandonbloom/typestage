import {copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import markdownit from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import {buildPlayground} from "./build-playground.ts";

hljs.registerLanguage("typescript", typescript);

const REPO = "https://github.com/brandonbloom/typestage";
const markdown = markdownit({
  html: false,
  linkify: false,
  typographer: false,
  highlight(code, language) {
    return highlight(code, language);
  },
});

markdown.core.ruler.after("inline", "rewrite_repo_links", (state) => {
  rewriteTokenLinks(state.tokens);
});

const projectRoot = process.cwd();
const siteSrc = join(projectRoot, "site");
const primerSrc = join(projectRoot, "docs", "primer.md");
const outDir = join(projectRoot, "dist", "site");

const HERO_SNIPPET = `import {q} from "typestage";

const fields = ["id", "name", "email"].map((name) =>
  q.ident\`\${name}: string\`
);

const trimCalls = fields.map((field) =>
  q.expr\`\${field}.trim()\`
);
const packValues = q.ident\`packValues\`;

export const generated = q.decls\`
  export type Row = Record<string, string>;

  export function pack(\${fields}) {
    return packValues(\${trimCalls});
  }
\`;`;

// The same record-factory generator, shown three ways on the landing page.
const TARGET_SNIPPET = `export function makeUser(id: string, age: number) {
  return { id, age };
}`;

const TEXT_TEMPLATE_SNIPPET = `const fields = [
  ["id", "string"],
  ["age", "number"],
];

const params = fields
  .map(([name, type]) => \`\${name}: \${type}\`)
  .join(", ");
const props = fields.map(([name]) => name).join(", ");

const code = \`export function makeUser(\${params}) {
  return { \${props} };
}\`;`;

const AST_SNIPPET = `import ts from "typescript";

const fields = [
  ["id", "string"],
  ["age", "number"],
] as const;

const f = ts.factory;
const keyword = (t: string) =>
  t === "number" ? ts.SyntaxKind.NumberKeyword : ts.SyntaxKind.StringKeyword;

const code = f.createFunctionDeclaration(
  [f.createModifier(ts.SyntaxKind.ExportKeyword)],
  undefined,
  f.createIdentifier("makeUser"),
  undefined,
  fields.map(([name, type]) =>
    f.createParameterDeclaration(
      undefined, undefined,
      f.createIdentifier(name), undefined,
      f.createKeywordTypeNode(keyword(type)),
    ),
  ),
  undefined,
  f.createBlock([
    f.createReturnStatement(
      f.createObjectLiteralExpression(
        fields.map(([name]) =>
          f.createShorthandPropertyAssignment(name),
        ),
      ),
    ),
  ]),
);`;

const TYPESTAGE_SNIPPET = `import {q} from "typestage";

const fields = [
  ["id", "string"],
  ["age", "number"],
] as const;

const params = fields.map(([name, type]) => q.ident\`\${name}: \${type}\`);
const props = fields.map(([name]) => q.expr\`\${name}\`);

export const code = q.decl\`
  export function makeUser(\${params}) {
    return {\${props}};
  }
\`;`;

const SNIPPETS: Record<string, string> = {
  __HERO_CODE__: HERO_SNIPPET,
  __TARGET_CODE__: TARGET_SNIPPET,
  __TEXT_TEMPLATE_CODE__: TEXT_TEMPLATE_SNIPPET,
  __AST_CODE__: AST_SNIPPET,
  __TYPESTAGE_CODE__: TYPESTAGE_SNIPPET,
};

rmSync(outDir, {force: true, recursive: true});
mkdirSync(outDir, {recursive: true});

for (const file of ["styles.css", "favicon.svg"]) {
  copyFileSync(join(siteSrc, file), join(outDir, file));
}

let indexHtml = readFileSync(join(siteSrc, "index.html"), "utf8");
for (const [placeholder, code] of Object.entries(SNIPPETS)) {
  indexHtml = indexHtml.replace(placeholder, () => highlight(code));
}
writeFileSync(join(outDir, "index.html"), indexHtml);

writeFileSync(join(outDir, "primer.html"), renderPrimer(readFileSync(primerSrc, "utf8")));

await buildPlayground(join(outDir, "playground"));

console.log(`Built static site into ${outDir}`);

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

function navLinks(active: string): string {
  const link = (href: string, label: string, cls = "") => {
    const className = [cls, active === label ? "active" : ""]
      .filter(Boolean)
      .join(" ");
    const attr = className ? ` class="${className}"` : "";
    return `<a${attr} href="${href}">${label}</a>`;
  };

  return `
        <nav class="nav-links">
          ${link("index.html", "Home", "home-link")}
          ${link("primer.html", "Primer")}
          ${link(REPO, "GitHub")}
          <a class="cta" href="playground/">Playground</a>
        </nav>`;
}

function page(title: string, description: string, active: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="icon" href="favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <header class="nav">
      <div class="nav-inner">
        <a class="brand" href="index.html">
          <img src="favicon.svg" alt="" />
          TypeStage
        </a>${navLinks(active)}
      </div>
    </header>
    <main>
${body}
    </main>
    <footer>
      <div class="wrap">TypeStage is experimental — the public surface and semantics are still being shaped.</div>
    </footer>
  </body>
</html>
`;
}

function renderPrimer(source: string): string {
  const tokens = parseMarkdown(source);
  const headings = extractHeadings(tokens);

  let title = "TypeStage Primer";
  const parts: string[] = [];
  let tocEmitted = false;

  for (let i = 0; i < tokens.length;) {
    const example = exampleAt(tokens, i);

    if (example) {
      parts.push(renderExample(example.source, example.output));
      i += example.tokenCount;
      continue;
    }

    const heading = headingAt(tokens, i);

    if (heading?.level === 1) {
      title = heading.text;
      parts.push(`      <div class="doc-head"><h1>${heading.html}</h1></div>`);
      i += heading.tokenCount;
      continue;
    }

    if (heading?.level === 2) {
      if (!tocEmitted) {
        parts.push(renderToc(headings));
        tocEmitted = true;
      }
      const id = slug(heading.text);
      parts.push(
        `      <h2 id="${id}">${heading.html}` +
          `<a class="anchor" href="#${id}" aria-label="Permalink">#</a></h2>`,
      );
      i += heading.tokenCount;
      continue;
    }

    parts.push(renderToken(tokens[i]));
    i++;
  }

  const body = `      <article class="doc">\n${parts.join("\n")}\n      </article>`;
  return page(
    `${title} — TypeStage`,
    "A tour of TypeStage concepts and quote forms, with source and emitted TypeScript shown side by side.",
    "Primer",
    body,
  );
}

function renderToc(headings: Heading[]): string {
  const items = headings
    .map(
      (heading) =>
        `          <li><a href="#${slug(heading.text)}">` +
          `${renderInlineText(stripNumber(heading.text))}</a></li>`,
    )
    .join("\n");
  return `      <nav class="toc"><strong>Contents</strong>\n        <ol>\n${items}\n        </ol>\n      </nav>`;
}

function renderExample(source: CodeBlock, output: CodeBlock): string {
  return `      <div class="example">
        <div class="pane source">
          <div class="pane-label">Source</div>
          ${renderCodeBlock(source)}
        </div>
        <div class="pane output">
          <div class="pane-label">Output</div>
          ${renderCodeBlock(output)}
        </div>
      </div>`;
}

type CodeBlock = {
  content: string;
  language: string;
};

type Heading = {
  html: string;
  level: number;
  text: string;
  tokenCount: number;
};

function parseMarkdown(source: string): Token[] {
  return markdown.parse(source, {});
}

function extractHeadings(tokens: Token[]): Heading[] {
  const headings: Heading[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const heading = headingAt(tokens, i);

    if (heading?.level === 2) {
      headings.push(heading);
    }
  }

  return headings;
}

function headingAt(tokens: Token[], index: number): Heading | undefined {
  const open = tokens[index];
  const inline = tokens[index + 1];
  const close = tokens[index + 2];

  if (
    open?.type !== "heading_open" ||
    inline?.type !== "inline" ||
    close?.type !== "heading_close"
  ) {
    return;
  }

  const level = Number(open.tag.slice(1));
  return {
    html: renderInlineToken(inline),
    level,
    text: inline.content,
    tokenCount: 3,
  };
}

function exampleAt(tokens: Token[], index: number): {
  output: CodeBlock;
  source: CodeBlock;
  tokenCount: number;
} | undefined {
  const sourceMarker = paragraphMarkerAt(tokens, index);
  const source = codeBlockAt(tokens[index + 3]);
  const outputMarker = paragraphMarkerAt(tokens, index + 4);
  const output = codeBlockAt(tokens[index + 7]);

  if (sourceMarker === "Source" && source && outputMarker === "Output" && output) {
    return {source, output, tokenCount: 8};
  }

  return;
}

function paragraphMarkerAt(tokens: Token[], index: number): string | undefined {
  const open = tokens[index];
  const inline = tokens[index + 1];
  const close = tokens[index + 2];

  if (
    open?.type !== "paragraph_open" ||
    inline?.type !== "inline" ||
    close?.type !== "paragraph_close"
  ) {
    return;
  }

  const children = inline.children ?? [];
  const meaningfulChildren = children.filter(
    (child) => child.type !== "text" || child.content !== "",
  );

  if (
    meaningfulChildren.length === 3 &&
    meaningfulChildren[0]?.type === "strong_open" &&
    meaningfulChildren[1]?.type === "text" &&
    meaningfulChildren[2]?.type === "strong_close"
  ) {
    return meaningfulChildren[1].content;
  }

  return;
}

function codeBlockAt(token: Token | undefined): CodeBlock | undefined {
  if (token?.type !== "fence" && token?.type !== "code_block") {
    return;
  }

  return {
    content: token.content,
    language: token.info.trim().split(/\s+/u)[0] ?? "",
  };
}

function renderToken(token: Token | undefined): string {
  return token ? markdown.renderer.render([token], markdown.options, {}) : "";
}

function renderInlineToken(token: Token): string {
  return markdown.renderer.render([token], markdown.options, {});
}

function renderInlineText(text: string): string {
  return markdown.renderInline(text);
}

function renderCodeBlock(block: CodeBlock): string {
  return `<pre><code>${highlight(block.content, block.language)}</code></pre>`;
}

function stripNumber(text: string): string {
  return text.replace(/^\d+\.\s*/, "");
}

function slug(text: string): string {
  return stripNumber(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Resolve a repo-relative markdown link (relative to `docs/`) to a GitHub URL. */
function rewriteHref(href: string): string {
  if (/^(https?:)?\/\//.test(href) || href.startsWith("#")) {
    return href;
  }

  if (href === "playground/" || href.startsWith("playground/?") || href.startsWith("playground/#")) {
    return href;
  }

  const parts = ["docs"];
  for (const segment of href.split("/")) {
    if (segment === "..") {
      parts.pop();
    } else if (segment !== "." && segment !== "") {
      parts.push(segment);
    }
  }

  const path = parts.join("/");
  const kind = parts[parts.length - 1]?.includes(".") ? "blob" : "tree";
  return `${REPO}/${kind}/main/${path}`;
}

function rewriteTokenLinks(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type === "link_open") {
      const href = token.attrGet("href");

      if (href) {
        token.attrSet("href", rewriteHref(href));
      }
    }

    if (token.children) {
      rewriteTokenLinks(token.children);
    }
  }
}

/** Highlight a TypeScript fragment to HTML using highlight.js (`.hljs-*` classes). */
function highlight(code: string, language = "typescript"): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(code, {language, ignoreIllegals: true}).value;
  }

  return markdown.utils.escapeHtml(code);
}
