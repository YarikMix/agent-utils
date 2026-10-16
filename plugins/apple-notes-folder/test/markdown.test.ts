import { describe, it, expect } from 'vitest';
import {
  extractImages,
  htmlToMarkdown,
  markdownToHtml,
  makeResolver,
  titleHtml,
  MAX_MARKDOWN_CHARS,
  imageHrefs,
} from '../src/markdown.js';

const noLoad = async (p: string): Promise<string> => {
  throw new Error(`load не должен вызываться: ${p}`);
};

const NOTE_HTML =
  '<div><h1>Заголовок</h1></div>' +
  '<div>Текст <b>жирный</b> и <i>курсив</i> <a href="https://example.com">ссылка</a></div>' +
  '<ul><li>один<ul><li>вложенный</li></ul></li><li>два</li></ul>' +
  '<div><strike>зачёркнуто</strike></div>' +
  '<pre><code>x &lt; y</code></pre>';

const WITH_IMAGES =
  '<div><h1>Т</h1></div><div>до</div>' +
  '<div><img src="data:image/png;base64,AAAA"></div><div>между</div>' +
  '<div><img src="data:image/png;base64,BBBB"></div>';

describe('imageHrefs', () => {
  it('uses the same marked traversal as rendering, including references and nested images', async () => {
    const md = '> ![a][ref]\n\n- [![b](two)](url)\n- ![again][ref]\n\n[ref]: <one with spaces>\n\n`![](ignored)`\n\n```\n![](ignored-code)\n```\n\n<img src="ignored-html">';
    const hrefs = imageHrefs(md);
    expect(hrefs).toEqual(['one with spaces', 'two']);
    const resolved: string[] = [];
    await markdownToHtml(md, async href => { resolved.push(href); return 'file:///verified'; });
    expect(resolved).toEqual(hrefs);
  });
});

describe('htmlToMarkdown', () => {
  it('переводит оформление Заметок в Markdown', () => {
    const { markdown } = htmlToMarkdown(NOTE_HTML);
    expect(markdown).toMatch(/^# Заголовок/);
    expect(markdown).toContain('**жирный**');
    expect(markdown).toContain('*курсив*');
    expect(markdown).toContain('[ссылка](https://example.com)');
    expect(markdown).toMatch(/^-\s+один/m);
    expect(markdown).toMatch(/^\s{4}-\s+вложенный/m);
    expect(markdown).toContain('~~зачёркнуто~~');
    expect(markdown).toContain('x < y');
  });

  it('заменяет картинки заглушками и не отдаёт base64', () => {
    const { markdown, images } = htmlToMarkdown(WITH_IMAGES);
    expect(markdown).toContain('![картинка 1](note-image:1)');
    expect(markdown).toContain('![картинка 2](note-image:2)');
    expect(markdown).not.toContain('base64');
    expect(images).toEqual(['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB']);
  });

  it('обрезает слишком длинный текст с пометкой', () => {
    const { markdown } = htmlToMarkdown(`<div>${'а'.repeat(MAX_MARKDOWN_CHARS + 50)}</div>`);
    expect(markdown.startsWith('а'.repeat(100))).toBe(true);
    expect(markdown).toMatch(/обрезано: заметка длиннее 200000 символов\]$/);
    expect(markdown.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS);
  });
});

describe('htmlToMarkdown с лимитом', () => {
  it('обрезка укладывается в переданный лимит', () => {
    const { markdown } = htmlToMarkdown(`<div>${'а'.repeat(5000)}</div>`, 1000);
    expect(markdown.length).toBeLessThanOrEqual(1000);
    expect(markdown).toMatch(/обрезано: заметка длиннее 1000 символов\]$/);
  });
});

describe('extractImages', () => {
  it('понимает src в одинарных кавычках', () => {
    const { html, images } = extractImages("<img alt='x' src='data:image/gif;base64,R0'>");
    expect(images).toEqual(['data:image/gif;base64,R0']);
    expect(html).toBe('<img src="note-image:1" alt="картинка 1">');
  });
});

describe('markdownToHtml', () => {
  it('собирает разметку, которую принимают Заметки', async () => {
    const html = await markdownToHtml('# T\n\nabc **b** *i* [л](https://example.com)\n\n#### глубоко', noLoad);
    expect(html).toContain('<h1>T</h1>');
    expect(html).toContain('<div>abc <b>b</b> <i>i</i> <a href="https://example.com">л</a></div>');
    expect(html).toContain('<h3>глубоко</h3>');
  });

  it('списки и код', async () => {
    const html = await markdownToHtml('- один\n- два\n\n```\nx < y\n```', noLoad);
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>один</li>');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('x &lt; y');
  });

  it('сырой HTML показывается как текст', async () => {
    const html = await markdownToHtml('<script>alert(1)</script>\n\nа <b>x</b>', noLoad);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('новая картинка встраивается через load — как file:// (Заметки не показывают data: нормально)', async () => {
    const load = async (p: string) =>
      p === '/private/tmp/claude-1/x.png' ? 'file:///private/tmp/claude-1/real.png' : 'bad';
    const html = await markdownToHtml('![](/private/tmp/claude-1/x.png)', makeResolver(load));
    expect(html).toContain('<img src="file:///private/tmp/claude-1/real.png">');
  });

  it('src картинки экранируется', async () => {
    const html = await markdownToHtml('![](/p.png)', makeResolver(async () => 'file:///a"b<c>&d'));
    expect(html).toContain('<img src="file:///a&quot;b&lt;c&gt;&amp;d">');
  });

  it('заглушка note-image:N во входе записи — всегда ошибка IMAGE_REF (заглушки принимает только чтение)', async () => {
    await expect(markdownToHtml('![](note-image:3)', makeResolver(noLoad))).rejects.toMatchObject({
      code: 'IMAGE_REF',
    });
    await expect(markdownToHtml('![](note-image:1)', makeResolver(noLoad))).rejects.toMatchObject({
      code: 'IMAGE_REF',
    });
  });
});

describe('titleHtml', () => {
  it('экранирует заголовок', () => {
    expect(titleHtml('<a> & "b"')).toBe('<div><h1>&lt;a&gt; &amp; &quot;b&quot;</h1></div>\n');
  });
});
