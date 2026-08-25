/**
 * Tests for the host classifier behind the SSRF guard.
 *
 * Mealie fetches every URL this server hands it — `preview_recipe_url` and
 * `import_recipe_from_url` both hand it to Mealie's own scraper, which
 * returns what it extracted. That
 * makes an unchecked URL a request from inside Mealie's network whose
 * response returns to the caller, which is why these cases matter.
 *
 * The IPv4-mapped literals are the shape that defeats a string comparison:
 * `URL` hands the guard `[::ffff:7f00:1]`, and every dual-stack client dials it
 * as 127.0.0.1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { internalHostKind } from '../src/hosts.js';
import { assertFetchableUrl } from '../src/schema.js';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

afterEach(() => {
  vi.restoreAllMocks();
  lookup.mockReset();
});

/** What `new URL(...).hostname` yields, brackets and all. */
function hostnameOf(url: string): string {
  return new URL(url).hostname;
}

describe('internalHostKind', () => {
  it.each([
    ['http://127.0.0.1/x', 'loopback'],
    ['http://127.42.9.1/x', 'loopback'],
    ['http://0.0.0.0/x', 'loopback'],
    ['http://localhost:3000/x', 'loopback'],
    ['http://admin.localhost/x', 'loopback'],
    ['http://[::1]/x', 'loopback'],
    ['http://[::]/x', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'link-local'],
    ['http://[fe80::1]/x', 'link-local'],
    ['http://[febf::1]/x', 'link-local'],
    // Spellings that a string comparison approves while a dual-stack client
    // dials the embedded IPv4 address.
    ['http://[::ffff:127.0.0.1]/x', 'loopback'],
    ['http://[::ffff:169.254.169.254]/x', 'link-local'],
    ['http://[0:0:0:0:0:ffff:7f00:1]/x', 'loopback'],
    ['http://[::127.0.0.1]/x', 'loopback'],
    ['http://[::ffff:0:169.254.169.254]/x', 'link-local'],
    ['http://[64:ff9b::169.254.169.254]/x', 'link-local'],
    // The root label makes the same name look different.
    ['http://localhost./x', 'loopback'],
    ['http://LOCALHOST/x', 'loopback'],
    // Names for the metadata service, which resolve only on the instance.
    ['http://metadata.google.internal/computeMetadata/v1/', 'link-local'],
    ['http://instance-data/latest/meta-data/', 'link-local'],
  ])('classifies %s as %s', (url, kind) => {
    expect(internalHostKind(hostnameOf(url))).toBe(kind);
  });

  it.each([
    // A self-hosted recipe manager is pointed at the LAN on purpose: the
    // router's interface, a NAS, an intranet page. Refusing those would break
    // the normal case.
    'http://192.168.1.50/recipe',
    'http://10.0.0.5/recipe',
    'http://172.16.4.4/x',
    'http://[fc00::1]/x',
    'https://example.com/recipe',
    'https://1.1.1.1/x',
    'https://[2606:4700::1111]/x',
    'https://127.0.0.1.example.com/x',
    'https://notlocalhost/x',
  ])('leaves %s alone', (url) => {
    expect(internalHostKind(hostnameOf(url))).toBeNull();
  });

  // `URL` always emits the compressed hex form, but the classifier also sees
  // raw addresses straight out of a DNS answer, where the dotted-quad
  // spellings are what actually turn up.
  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['::127.0.0.1', 'loopback'],
    ['0:0:0:0:0:ffff:a9fe:a9fe', 'link-local'],
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['FE80::1', 'link-local'],
    ['METADATA.GOOGLE.INTERNAL.', 'link-local'],
  ])('classifies the bare literal %s as %s', (host, kind) => {
    expect(internalHostKind(host)).toBe(kind);
  });

  it.each([
    ['http://100.100.100.200/latest/meta-data/', 'link-local'],
    ['http://192.0.0.192/latest/', 'link-local'],
  ])('classifies the metadata endpoint %s as %s', (url, kind) => {
    expect(internalHostKind(hostnameOf(url))).toBe(kind);
  });

  it.each([
    ['::ffff:127.0.0.1%lo', 'loopback'],
    ['::ffff:169.254.169.254%eth0', 'link-local'],
    ['fe80::1%eth0', 'link-local'],
    ['::%lo', 'loopback'],
  ])('classifies %s as %s despite the scope id', (host, kind) => {
    expect(internalHostKind(host)).toBe(kind);
  });

  it.each([
    '::ffff:1.1.1.1',
    '2606:4700:4700::1111',
    'not a host at all',
    '',
    '1:2:3:4:5:6:7:8:9',
  ])('leaves the bare literal %j alone', (host) => {
    expect(internalHostKind(host)).toBeNull();
  });
});

describe('assertFetchableUrl', () => {
  it('returns the parsed URL, not the string it was given', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertFetchableUrl('  https://example.com/a  ')).resolves.toBe(
      'https://example.com/a'
    );
  });

  it('normalises an authority a fetcher would read differently', async () => {
    // WHATWG URL reads the host as ok.example.com; curl splits at the @ and
    // connects to 127.0.0.1. Passing the input through would mean checking one
    // host and fetching the other.
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const sent = await assertFetchableUrl(
      'http://ok.example.com\\@127.0.0.1/feed'
    );
    expect(new URL(sent).hostname).toBe('ok.example.com');
    expect(sent).not.toContain('ok.example.com\\@');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x'])(
    'refuses the scheme of %s',
    async (url) => {
      await expect(assertFetchableUrl(url)).rejects.toThrow(
        /only http:\/\/ and https:\/\//
      );
    }
  );

  it('refuses a name that resolves to loopback', async () => {
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      assertFetchableUrl('http://recipe.attacker.example/x')
    ).rejects.toThrow(/loopback/);
  });

  it('refuses a name whose second address is the metadata service', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ]);
    await expect(
      assertFetchableUrl('http://recipe.attacker.example/x')
    ).rejects.toThrow(/link-local/);
  });

  it('allows a name it cannot resolve, which Mealie may still reach', async () => {
    lookup.mockRejectedValue(
      Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
    );
    await expect(
      assertFetchableUrl('https://intranet.example/x')
    ).resolves.toBe('https://intranet.example/x');
  });

  it('decides a literal without asking the resolver', async () => {
    await expect(assertFetchableUrl('https://1.1.1.1/x')).resolves.toBe(
      'https://1.1.1.1/x'
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a literal without asking the resolver either', async () => {
    await expect(assertFetchableUrl('http://127.0.0.1/x')).rejects.toThrow(
      /loopback/
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a value that is not a URL at all', async () => {
    await expect(assertFetchableUrl('not a url')).rejects.toThrow(
      /not a valid URL/
    );
  });
});
