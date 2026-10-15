import TurndownService from 'turndown';
import { Marked, type Tokens } from 'marked';
import { ToolError } from './errors.js';

export const MAX_MARKDOWN_CHARS = 200_000;
/** Начало пометки, которой htmlToMarkdown отмечает обрезанный текст (без числа лимита). */
export const TRUNCATION_MARKER_PREFIX = '[… обрезано: заметка длиннее';

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const PLACEHOLDER = /^note-image:(\d+)$/;

export type ImageResolver = (href: string) => Promise<string>;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Заменяет картинки тела заметки заглушками note-image:N; base64 остаётся только в images. */
export function extractImages(html: string): { html: string; images: string[] } {
  const images: string[] = [];
  const out = html.replace(IMG_TAG, (tag) => {
    const m = SRC_ATTR.exec(tag);
    images.push(m ? (m[1] ?? m[2]) : '');
    const n = images.length;
    return `<img src="note-image:${n}" alt="картинка ${n}">`;
  });
  return { html: out, images };
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  td.addRule('strike', {
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  });
  return td;
}

export function htmlToMarkdown(html: string, maxChars: number = MAX_MARKDOWN_CHARS): { markdown: string; images: string[] } {
  const { html: stripped, images } = extractImages(html);
  let markdown = makeTurndown().turndown(stripped).trim();
  if (markdown.length > maxChars) {
    const marker = `\n\n${TRUNCATION_MARKER_PREFIX} ${maxChars} символов]`;
    markdown = markdown.slice(0, maxChars - marker.length) + marker;
  }
  return { markdown, images };
}

/** note-image:N всегда отклоняется: заглушки принимает только чтение (notes_read), запись их не разрешает. */
export function makeResolver(load: (path: string) => Promise<string>): ImageResolver {
  return async (href) => {
    if (PLACEHOLDER.test(href)) {
      throw new ToolError('IMAGE_REF', `Ссылка ${href} не соответствует ни одной картинке заметки.`);
    }
    return load(href);
  };
}

function imageTokens(md: string) {
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(md);

  const hrefs = new Set<string>();
  marked.walkTokens(tokens, (t) => {
    if (t.type === 'image') hrefs.add((t as Tokens.Image).href);
  });
  return { marked, tokens, hrefs: [...hrefs] };
}

export function imageHrefs(markdown: string): string[] {
  return imageTokens(markdown).hrefs;
}

export async function markdownToHtml(md: string, resolve: ImageResolver): Promise<string> {
  const { marked, tokens, hrefs } = imageTokens(md);
  const srcs = new Map<string, string>();
  for (const href of hrefs) if (!srcs.has(href)) srcs.set(href, await resolve(href));

  marked.use({
    renderer: {
      html(token) {
        return escapeHtml(token.text);
      },
      image(token) {
        return `<img src="${escapeHtml(srcs.get(token.href) ?? '')}">`;
      },
      paragraph(token) {
        return `<div>${this.parser.parseInline(token.tokens)}</div>\n`;
      },
      heading(token) {
        const d = Math.min(token.depth, 3);
        return `<h${d}>${this.parser.parseInline(token.tokens)}</h${d}>\n`;
      },
      strong(token) {
        return `<b>${this.parser.parseInline(token.tokens)}</b>`;
      },
      em(token) {
        return `<i>${this.parser.parseInline(token.tokens)}</i>`;
      },
    },
  });
  return marked.parser(tokens);
}

export function titleHtml(title: string): string {
  return `<div><h1>${escapeHtml(title)}</h1></div>\n`;
}
