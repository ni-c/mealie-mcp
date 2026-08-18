import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
  type Config,
} from '../src/config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function silence() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

describe('loadConfig', () => {
  it('reads the full configuration', () => {
    silence();
    const env = {
      MEALIE_URL: 'https://mealie.example.com',
      MEALIE_API_TOKEN: 'secret',
      MEALIE_ACCEPT_LANGUAGE: 'de-DE',
      MEALIE_READ_ONLY: 'true',
      MEALIE_INSECURE_TLS: 'true',
    } as NodeJS.ProcessEnv;
    expect(loadConfig(env)).toEqual({
      url: 'https://mealie.example.com',
      token: 'secret',
      acceptLanguage: 'de-DE',
      readOnly: true,
      insecureTls: true,
    });
  });

  it('strips trailing slashes from the URL', () => {
    silence();
    const config = loadConfig({
      MEALIE_URL: 'https://mealie.example.com///',
      MEALIE_API_TOKEN: 't',
    } as NodeJS.ProcessEnv);
    expect(config.url).toBe('https://mealie.example.com');
  });

  it('treats the booleans as exactly "true"', () => {
    silence();
    const config = loadConfig({
      MEALIE_URL: 'https://mealie.example.com',
      MEALIE_API_TOKEN: 't',
      MEALIE_READ_ONLY: 'True',
      MEALIE_INSECURE_TLS: '1',
    } as NodeJS.ProcessEnv);
    // A typo in READ_ONLY therefore fails OPEN. Documented, and the reason the
    // startup banner in index.ts prints the effective mode.
    expect(config.readOnly).toBe(false);
    expect(config.insecureTls).toBe(false);
  });

  it('removes the token from the environment', () => {
    silence();
    const env = {
      MEALIE_URL: 'https://mealie.example.com',
      MEALIE_API_TOKEN: 'secret',
    } as NodeJS.ProcessEnv;
    const config = loadConfig(env);
    expect(config.token).toBe('secret');
    expect(env.MEALIE_API_TOKEN).toBeUndefined();
  });

  it('removes the token even when the URL is missing', () => {
    // Regression: with the delete at the end of the function, the early return
    // for a missing URL leaves the token in the environment for the process
    // lifetime, where any child process can read it out of /proc/<pid>/environ.
    silence();
    const env = { MEALIE_API_TOKEN: 'secret' } as NodeJS.ProcessEnv;
    const config = loadConfig(env);
    expect(config.url).toBeUndefined();
    expect(config.token).toBe('secret');
    expect(env.MEALIE_API_TOKEN).toBeUndefined();
  });

  it('starts without credentials and warns', () => {
    const log = silence();
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.url).toBeUndefined();
    expect(config.token).toBeUndefined();
    expect(log.mock.calls[0]?.[0]).toContain('MEALIE_URL');
    expect(log.mock.calls[0]?.[0]).toContain('MEALIE_API_TOKEN');
  });

  it('warns about plain http to a remote host but keeps going', () => {
    const log = silence();
    const config = loadConfig({
      MEALIE_URL: 'http://mealie.example.com',
      MEALIE_API_TOKEN: 't',
    } as NodeJS.ProcessEnv);
    expect(config.url).toBe('http://mealie.example.com');
    expect(
      log.mock.calls.some(([m]) => String(m).includes('unencrypted'))
    ).toBe(true);
  });

  it('does not warn about plain http to a loopback host', () => {
    const log = silence();
    for (const url of [
      'http://localhost:9000',
      'http://127.0.0.1:9000',
      'http://mealie.localhost',
      'http://[::1]:9000',
    ]) {
      loadConfig({
        MEALIE_URL: url,
        MEALIE_API_TOKEN: 't',
      } as NodeJS.ProcessEnv);
    }
    expect(
      log.mock.calls.some(([m]) => String(m).includes('unencrypted'))
    ).toBe(false);
  });

  it('exits on a malformed URL without echoing it', () => {
    const log = silence();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    expect(() =>
      loadConfig({
        MEALIE_URL: 'mealie.example.com',
        MEALIE_API_TOKEN: 'secret',
      } as NodeJS.ProcessEnv)
    ).toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);
    // A token pasted into MEALIE_URL by mistake must not be logged. Asserting
    // the exact and only log line is stronger than a substring check: nothing
    // else was written, so the value cannot have been echoed anywhere.
    expect(log.mock.calls.map(([m]) => String(m))).toEqual([
      'mealie-mcp: MEALIE_URL is not a valid absolute URL',
    ]);
  });

  it('exits on a non-http scheme', () => {
    silence();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    expect(() =>
      loadConfig({
        MEALIE_URL: 'file:///etc/passwd',
        MEALIE_API_TOKEN: 't',
      } as NodeJS.ProcessEnv)
    ).toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits when the URL carries a query or fragment', () => {
    // `https://host#x` + `/api/recipes` would send the token-bearing request
    // to `/` of the host, the intended path swallowed by the fragment.
    silence();
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    for (const url of [
      'https://mealie.example.com#fragment',
      'https://mealie.example.com?a=b',
    ]) {
      const attempt = () =>
        loadConfig({
          MEALIE_URL: url,
          MEALIE_API_TOKEN: 't',
        } as NodeJS.ProcessEnv);
      expect(attempt, url).toThrow('exited');
    }
  });

  it('exits when the URL carries credentials', () => {
    // They would end up in logs and error messages; the token belongs in
    // MEALIE_API_TOKEN, which is deleted from the environment after load.
    silence();
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    expect(() =>
      loadConfig({
        MEALIE_URL: 'https://user:pass@mealie.example.com',
        MEALIE_API_TOKEN: 't',
      } as NodeJS.ProcessEnv)
    ).toThrow('exited');
  });
});

describe('missingConfigKeys', () => {
  const base: Config = {
    url: 'https://mealie.example.com',
    token: 't',
    acceptLanguage: undefined,
    insecureTls: false,
    readOnly: false,
  };

  it('reports nothing when configured', () => {
    expect(missingConfigKeys(base)).toEqual([]);
  });

  it('names each missing variable', () => {
    expect(missingConfigKeys({ ...base, url: undefined })).toEqual([
      'MEALIE_URL',
    ]);
    expect(
      missingConfigKeys({ ...base, url: undefined, token: undefined })
    ).toEqual(['MEALIE_URL', 'MEALIE_API_TOKEN']);
  });
});

describe('missingConfigMessage', () => {
  it('explains where the token comes from', () => {
    const message = missingConfigMessage(['MEALIE_API_TOKEN']);
    expect(message).toContain('Settings → API Tokens');
    expect(message).toContain('MEALIE_READ_ONLY');
  });
});
