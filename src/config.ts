import { internalHostKind } from 'mcp-internal-hosts';

export interface Config {
  /**
   * Base URL of the Mealie instance, e.g. `https://mealie.example.com`.
   * May be undefined together with the token: the server still starts and lists
   * its tools, every API call then fails with {@link missingConfigMessage}.
   */
  url: string | undefined;
  token: string | undefined;
  /**
   * Value for the `accept-language` header Mealie honours on nearly every
   * endpoint. It localises unit names, label names and validation messages.
   * Undefined leaves the choice to the server default.
   */
  acceptLanguage: string | undefined;
  insecureTls: boolean;
  readOnly: boolean; /**
   * Raw value of `MEALIE_ALLOW_TOOLS` — comma-separated tool names, `list_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror of
   * the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `MEALIE_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

/** Shown when the configuration is incomplete — at startup and on every API call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: MEALIE_URL (e.g. https://mealie.example.com), MEALIE_API_TOKEN\n' +
    'Create the token in Mealie under Settings → API Tokens; it acts as the user ' +
    'who created it and inherits that user’s group, household and permissions.\n' +
    'Optional: MEALIE_READ_ONLY=true to expose only read tools, ' +
    'MEALIE_ACCEPT_LANGUAGE (e.g. de-DE) to localise names, ' +
    'MEALIE_INSECURE_TLS=true to accept self-signed certificates'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [
    !config.url && 'MEALIE_URL',
    !config.token && 'MEALIE_API_TOKEN',
  ].filter((v): v is string => Boolean(v));
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. A malformed URL still
 * exits — that one could send the token to the wrong host.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.MEALIE_URL;
  const token = env.MEALIE_API_TOKEN;
  const acceptLanguage = env.MEALIE_ACCEPT_LANGUAGE;
  const insecureTls = env.MEALIE_INSECURE_TLS === 'true';
  const readOnly = env.MEALIE_READ_ONLY === 'true';
  const allowTools = env.MEALIE_ALLOW_TOOLS;
  const denyTools = env.MEALIE_DENY_TOOLS;

  // Removed here, before any branch below can return early: the token must not
  // stay in the environment for the process lifetime, where it is visible to
  // child processes and in /proc/<pid>/environ. Reading it into a local first is
  // what makes the early returns safe.
  delete env.MEALIE_API_TOKEN;

  const missing = [!url && 'MEALIE_URL', !token && 'MEALIE_API_TOKEN'].filter(
    (v): v is string => Boolean(v)
  );

  if (missing.length > 0) {
    console.error(`mealie-mcp: ${missingConfigMessage(missing)}`);
  }

  if (!url) {
    return {
      url: undefined,
      token,
      acceptLanguage,
      insecureTls,
      readOnly,
      allowTools,
      denyTools,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Deliberately without the value: a token pasted into the wrong variable
    // would be echoed into the log by an error message that quotes it.
    console.error('mealie-mcp: MEALIE_URL is not a valid absolute URL');
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(
      `mealie-mcp: MEALIE_URL must use http:// or https:// (got ${parsed.protocol})`
    );
    process.exit(1);
  }
  // Credentials embedded in the URL would end up in logs and error messages.
  if (parsed.username || parsed.password) {
    console.error(
      'mealie-mcp: MEALIE_URL must not contain credentials — use MEALIE_API_TOKEN'
    );
    process.exit(1);
  }
  // A query or fragment silently corrupts every request URL built from this
  // base: `…#x` + `/api/recipes` sends the token-bearing request to `/` of the
  // host, with the intended path swallowed by the fragment.
  if (parsed.search || parsed.hash) {
    console.error(
      'mealie-mcp: MEALIE_URL must not contain a query string or fragment'
    );
    process.exit(1);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    console.error(
      'mealie-mcp: WARNING: MEALIE_URL uses plain http to a non-local host — ' +
        'the API token will be sent unencrypted. Use https:// instead.'
    );
  }

  return {
    url: url.replace(/\/+$/, ''),
    token,
    acceptLanguage,
    insecureTls,
    readOnly,
    allowTools,
    denyTools,
  };
}

function isLoopbackHost(hostname: string): boolean {
  // The same classifier the SSRF guard uses, so a loopback URL written as
  // http://[::1]:9000 or http://[::ffff:127.0.0.1]:9000 is recognised here too
  // and the plain-http warning does not fire on it.
  return internalHostKind(hostname) === 'loopback';
}
