import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageUrlsIn } from '../src/tools/imports.js';
import { callsOf, callText, connect, mockFetch } from './harness.js';

/**
 * `import_recipe_from_html_or_json` and the request it makes without asking.
 *
 * The tool's name says the document comes in directly, and its annotation used
 * to say `openWorldHint: false` on that basis. Measured against
 * `ghcr.io/mealie-recipes/mealie:v3.22.0`: posting
 * `{"@type":"Recipe","image":"http://<host>:9932/latest/meta-data/"}` to
 * `/api/recipes/create/html-or-json` puts
 *
 *   INFO  Image URL: http://<host>:9932/latest/meta-data/
 *   ERROR Fatal Image Request Exception … recipe_data_service.py line 151, in
 *         scrape_image … safehttp.resilient_fetch(image_url_str)
 *
 * in Mealie's log. Mealie's own guard stopped that particular address because
 * it was RFC1918; it refuses on `ipaddress.ip_address(...).is_private`, which
 * is **False** for `100.100.100.200` — the Alibaba metadata service — and for
 * all of `100.64.0.0/10`. `mcp-internal-hosts` classifies the first of those as
 * link-local, so running the extracted addresses through `assertFetchableUrl`
 * closes the part Mealie leaves open.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('imageUrlsIn', () => {
  it('finds the address in each shape schema.org uses', () => {
    expect(imageUrlsIn('{"image":"https://a.example/1.jpg"}')).toEqual([
      'https://a.example/1.jpg',
    ]);
    expect(
      imageUrlsIn('{"image":["https://b.example/1.jpg","https://c.example/2"]}')
    ).toEqual(['https://b.example/1.jpg', 'https://c.example/2']);
    expect(
      imageUrlsIn(
        '{"image":{"@type":"ImageObject","url":"https://d.example/x"}}'
      )
    ).toEqual(['https://d.example/x']);
    expect(imageUrlsIn('{"thumbnailUrl":"https://e.example/t.png"}')).toEqual([
      'https://e.example/t.png',
    ]);
  });

  it('finds the address in the HTML shapes', () => {
    expect(
      imageUrlsIn('<img class="hero" src="https://f.example/h.jpg">')
    ).toEqual(['https://f.example/h.jpg']);
    expect(
      imageUrlsIn(
        '<meta property="og:image" content="https://g.example/og.png" />'
      )
    ).toEqual(['https://g.example/og.png']);
  });

  it('ignores what Mealie cannot fetch out of a pasted document', () => {
    // A relative src has no base to resolve against here, and a data: image is
    // ordinary — refusing either would break working imports rather than
    // prevent a request.
    expect(imageUrlsIn('<img src="/static/hero.jpg">')).toEqual([]);
    expect(imageUrlsIn('<img src="data:image/png;base64,AAAA">')).toEqual([]);
    expect(imageUrlsIn('{"image":"ftp://h.example/x.jpg"}')).toEqual([]);
    expect(imageUrlsIn('a document with no image at all')).toEqual([]);
  });

  it('reports one address per host and stops at a sensible number', () => {
    const many = Array.from(
      { length: 40 },
      (_, index) => `<img src="https://cdn.example/${index}.jpg">`
    ).join('');
    expect(imageUrlsIn(many)).toHaveLength(1);

    const hosts = Array.from(
      { length: 40 },
      (_, index) => `<img src="https://h${index}.example/x.jpg">`
    ).join('');
    expect(imageUrlsIn(hosts)).toHaveLength(25);
  });

  it('does not take a long time over a hostile document', () => {
    // The scan runs over up to 2 MB of caller-supplied text. Tags are cut out
    // before their attributes are read so that no pattern nests a quantifier
    // inside another one.
    const hostile = `<img ${'a'.repeat(200_000)}="${'b'.repeat(200_000)}`;
    const started = performance.now();
    expect(imageUrlsIn(hostile)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('import_recipe_from_html_or_json', () => {
  it('says it reaches outside, because it does', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find(
      (candidate) => candidate.name === 'import_recipe_from_html_or_json'
    );
    expect(tool!.annotations?.openWorldHint).toBe(true);
  });

  it('refuses a document pointing Mealie at a metadata service', async () => {
    // 100.100.100.200 is the address Mealie's own check waves through:
    // `ip_address('100.100.100.200').is_private` is False in CPython.
    const spy = mockFetch();
    const { text, isError } = await callText(
      await connect(),
      'import_recipe_from_html_or_json',
      {
        data: JSON.stringify({
          '@type': 'Recipe',
          name: 'Probe',
          image: 'http://100.100.100.200/latest/meta-data/',
        }),
      }
    );
    expect(isError).toBe(true);
    expect(text).toContain('link-local');
    expect(spy, 'the document reached Mealie anyway').not.toHaveBeenCalled();
  });

  it('refuses a loopback image address in an HTML document', async () => {
    const spy = mockFetch();
    const { text, isError } = await callText(
      await connect(),
      'import_recipe_from_html_or_json',
      { data: '<html><img src="http://127.0.0.1:9000/admin"></html>' }
    );
    expect(isError).toBe(true);
    expect(text).toContain('loopback');
    expect(spy).not.toHaveBeenCalled();
  });

  it('imports an ordinary document unchanged', async () => {
    const spy = mockFetch();
    const document = JSON.stringify({
      '@type': 'Recipe',
      name: 'Quark Bowl',
      image: 'https://example.com/quark.jpg',
    });
    const { isError } = await callText(
      await connect(),
      'import_recipe_from_html_or_json',
      { data: document }
    );
    expect(isError).toBe(false);
    // The document is handed over as written — the check is a gate, not a
    // rewrite.
    expect(callsOf(spy)[0]!.body).toEqual({ data: document });
  });
});
