import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeEntities, imageUrlsIn } from '../src/tools/imports.js';
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

  it('reports one address per host and refuses a document naming too many', () => {
    const many = Array.from(
      { length: 40 },
      (_, index) => `<img src="https://cdn.example/${index}.jpg">`
    ).join('');
    expect(imageUrlsIn(many)).toHaveLength(1);

    // The 26th host used to be skipped in silence — an address the scan did
    // not check, handed to Mealie unchecked.
    const hosts = Array.from(
      { length: 26 },
      (_, index) => `<img src="https://h${index}.example/x.jpg">`
    ).join('');
    expect(() => imageUrlsIn(hosts)).toThrow(/more than 25 different hosts/);
    expect(imageUrlsIn(hosts.slice(0, hosts.lastIndexOf('<img')))).toHaveLength(
      25
    );
  });

  it('refuses a document with more image references than a recipe page has', () => {
    const references = Array.from(
      { length: 501 },
      () => '<img src="https://cdn.example/x.jpg">'
    ).join('');
    expect(() => imageUrlsIn(references)).toThrow(
      /more than 500 image references/
    );
    expect(() => imageUrlsIn(`{"image":[${'"x",'.repeat(500)}"y"]}`)).toThrow(
      /more than 500 image references/
    );
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

/**
 * The scan has to decode what Mealie's parsers decode, or the guard checks
 * one address and Mealie fetches another. Each vector here was a reproduced
 * bypass: the JSON escape yielded no candidate at all, the character
 * reference yielded the host `&`.
 */
describe('imageUrlsIn reads what the other side reads', () => {
  const META = 'http://100.100.100.200/latest/meta-data/';

  it('decodes JSON escapes in a value — PHP writes \\/ by default', () => {
    const escaped = JSON.stringify({ '@type': 'Recipe', image: META }).replace(
      /\//g,
      '\\/'
    );
    expect(imageUrlsIn(escaped)).toEqual([META]);
    // The same document as a fragment the JSON parser refuses (Python's
    // accepts `NaN`), so the text reading has to find it too.
    expect(
      imageUrlsIn(`{"x": NaN, "image": "http:\\/\\/100.100.100.200\\/"}`)
    ).toEqual(['http://100.100.100.200/']);
  });

  it('decodes an escaped key — "\\u0069mage" is "image" to Mealie', () => {
    expect(imageUrlsIn(`{"\\u0069mage":"${META}"}`)).toEqual([META]);
    expect(imageUrlsIn(`{"x": NaN, "\\u0069mage":"${META}"}`)).toEqual([META]);
  });

  it('decodes character references in an attribute, every digit of them', () => {
    for (const content of [
      'http://&#49;00.100.100.200/',
      'http://&#0000000049;00.100.100.200/',
      'http://&#x31;00.100.100.200/',
      'http://&#X31;00.100.100.200/',
      'http://&#4900.100.100.200/'.replace('&#4900', '&#49;00'),
    ]) {
      expect(
        imageUrlsIn(`<meta property="og:image" content="${content}">`),
        content
      ).toEqual(['http://100.100.100.200/']);
    }
  });

  it('reads the microdata and link shapes extruct reads', () => {
    expect(
      imageUrlsIn('<meta itemprop="image" content="https://m.example/x.jpg">')
    ).toEqual(['https://m.example/x.jpg']);
    expect(
      imageUrlsIn('<link rel="image_src" href="https://l.example/x.jpg">')
    ).toEqual(['https://l.example/x.jpg']);
    expect(
      imageUrlsIn('<link itemprop="image" href="https://i.example/x.jpg">')
    ).toEqual(['https://i.example/x.jpg']);
    expect(imageUrlsIn('<img src=https://bare.example/x.jpg alt=x>')).toEqual([
      'https://bare.example/x.jpg',
    ]);
  });

  it('reads a JSON-LD block inside HTML as JSON', () => {
    const page =
      '<html><head><script type="application/ld+json">' +
      `{"@context":"https://schema.org","@type":"Recipe","\\u0069mage":{"@type":"ImageObject","url":"${META}"}}` +
      '</script></head></html>';
    expect(imageUrlsIn(page)).toEqual([META]);
  });

  it('refuses an absolute address it cannot parse rather than passing it on', () => {
    // A port out of range is not a relative path: it names a scheme and a
    // host, and Mealie's fetcher would read it its own way.
    expect(() => imageUrlsIn('{"image":"http://127.0.0.1:99999/x"}')).toThrow(
      /cannot parse/
    );
    expect(() => imageUrlsIn('<img src="https://exa mple.com/x.jpg">')).toThrow(
      /cannot parse/
    );
    // A protocol-relative address is absolute too.
    expect(imageUrlsIn('<img src="//p.example/x.jpg">')).toEqual([
      'https://p.example/x.jpg',
    ]);
  });

  it('turns a zero, a surrogate and an overflow into U+FFFD, never nothing', () => {
    const replacement = String.fromCodePoint(0xfffd);
    expect(decodeEntities('a&#0;b')).toBe(`a${replacement}b`);
    expect(decodeEntities('a&#xD800;b')).toBe(`a${replacement}b`);
    expect(decodeEntities('a&#1114112;b')).toBe(`a${replacement}b`);
    expect(decodeEntities(`a&#${'9'.repeat(300)};b`)).toBe(`a${replacement}b`);
    // Decoded once: `&#x26;#104;` is `&#104;` to a browser, not `h`.
    expect(decodeEntities('&#x26;#104;')).toBe('&#104;');
    expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;&unknown;')).toBe(
      '&<>"\'&unknown;'
    );
  });

  it('decodes every scalar value under every zero padding', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 0x10ffff })
          .filter((n) => n < 0xd800 || n > 0xdfff),
        fc.integer({ min: 0, max: 12 }),
        fc.boolean(),
        (point, zeros, hex) => {
          const digits = hex ? point.toString(16) : String(point);
          const reference = `&#${hex ? 'x' : ''}${'0'.repeat(zeros)}${digits};`;
          expect(decodeEntities(reference)).toBe(String.fromCodePoint(point));
        }
      ),
      { numRuns: 500 }
    );
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

describe('imageUrlsIn at the edges of a document', () => {
  it('reads an image region that never closes', () => {
    expect(imageUrlsIn('{"x": NaN, "image": ["https://a.example/1"')).toEqual([
      'https://a.example/1',
    ]);
    expect(imageUrlsIn('{"x": NaN, "image": 12')).toEqual([]);
  });

  it('skips scripts that are not JSON-LD and reads a malformed block as text', () => {
    const page =
      '<script src="/app.js"></script>' +
      '<script type="application/ld+json">{"x": NaN, "image": "https://b.example/2"}</script>' +
      '<script type="application/ld+json">{"image": "https://c.example/3"}';
    expect(imageUrlsIn(page)).toEqual([
      'https://b.example/2',
      'https://c.example/3',
    ]);
  });

  it('uses a literal as written when its escapes are not JSON', () => {
    expect(imageUrlsIn('{"x": NaN, "image": "https://d.example/\\q"}')).toEqual(
      ['https://d.example//q']
    );
  });
});
