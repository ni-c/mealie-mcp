import { internalHostKind } from 'mcp-internal-hosts';
import { quoted } from './text.js';

/**
 * What an API token may look like: visible ASCII, no whitespace. Mealie's
 * tokens are JWTs, so the real shape is narrower — but this check is not about
 * recognising a token, it is about refusing a value a header cannot carry.
 * undici refuses one with a control character in it by quoting the whole value
 * in its error, and that error used to reach the model.
 */
export const TOKEN_SHAPE = /^[!-~]{1,4096}$/;

/** A list of language ranges, as `Accept-Language` carries them. */
const ACCEPT_LANGUAGE_SHAPE = /^[A-Za-z0-9*,;=.\- ]{1,64}$/;

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
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;
  /**
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
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal: this is the first variable of the family that defaults to *on*. The
 * others fail open on a typo, which is the safe direction for them. Here a typo
 * would leave the dialog running while the operator believes it is off — and an
 * operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  // `quoted` rather than the raw value: this variable sits next to the token
  // in every compose file, and a value that matches nothing is exactly what a
  // secret pasted into the wrong line looks like.
  console.error(
    `mealie-mcp: ELICITATION must be "true" or "false" — got ${quoted(raw ?? '')}. ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
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
  // Trimmed: a trailing newline from `$(cat token)` is the commonest way a
  // token arrives broken, and it is not the operator's intent.
  const token = env.MEALIE_API_TOKEN?.trim();
  const acceptLanguage = env.MEALIE_ACCEPT_LANGUAGE?.trim();
  // `MEALIE_INSECURE_TLS` stays exact on purpose: it *weakens* the server, so
  // only the one spelling that unambiguously asks for it should do it.
  const insecureTls = env.MEALIE_INSECURE_TLS === 'true';
  // `MEALIE_READ_ONLY` is the other direction — it only ever takes capability
  // away — so the fleet form is generous with the spelling. An operator who
  // wrote `1` or `yes` meant the safe thing, and `MEALIE_READ_ONLY=true ` with
  // a trailing space used to mean the unsafe one.
  const readOnly = /^(1|true|yes)$/i.test(env.MEALIE_READ_ONLY?.trim() ?? '');
  const allowTools = env.MEALIE_ALLOW_TOOLS;
  const denyTools = env.MEALIE_DENY_TOOLS;

  // Removed here, before any branch below can return early: the token must not
  // stay in the environment for the process lifetime, where it is visible to
  // child processes and in /proc/<pid>/environ. Reading it into a local first is
  // what makes the early returns safe.
  delete env.MEALIE_API_TOKEN;

  // After the delete, deliberately: this one can exit the process, and an exit
  // above would leave the credential in the environment for whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  // The token's shape, without the token: a value with a character a header
  // cannot carry is refused here, where the message can say so without
  // quoting it. Past this point the value is only ever used, never printed.
  if (token !== undefined && token !== '' && !TOKEN_SHAPE.test(token)) {
    console.error(
      `mealie-mcp: MEALIE_API_TOKEN has an unexpected shape (${token.length} characters) — ` +
        'it must be visible ASCII without spaces or line breaks. Refusing to start.'
    );
    process.exit(1);
  }

  let language: string | undefined;
  if (acceptLanguage !== undefined && acceptLanguage !== '') {
    if (ACCEPT_LANGUAGE_SHAPE.test(acceptLanguage)) {
      language = acceptLanguage;
    } else {
      console.error(
        `mealie-mcp: MEALIE_ACCEPT_LANGUAGE is not a language range (${acceptLanguage.length} characters); ` +
          'ignoring it. Use a value like de-DE or en.'
      );
    }
  }

  const missing = [!url && 'MEALIE_URL', !token && 'MEALIE_API_TOKEN'].filter(
    (v): v is string => Boolean(v)
  );

  if (missing.length > 0) {
    console.error(`mealie-mcp: ${missingConfigMessage(missing)}`);
  }

  if (!url) {
    return {
      url: undefined,
      token: token || undefined,
      acceptLanguage: language,
      insecureTls,
      readOnly,
      elicitation,
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
    // Without the scheme: a 56-character hexadecimal key with a colon after it
    // is a valid URL whose scheme is the key.
    console.error(
      'mealie-mcp: MEALIE_URL must use http:// or https:// (got another scheme)'
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

  // What was checked is what is used: the parsed origin and path, not the
  // string that came in. `URL` strips a stray tab or newline and lower-cases
  // the host; the raw string would have glued those in front of every request.
  let pathname = parsed.pathname;
  while (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const stored = `${parsed.origin}${pathname}`;
  if (stored !== url) {
    console.error(`mealie-mcp: MEALIE_URL normalised to ${stored}`);
  }

  return {
    url: stored,
    token: token || undefined,
    acceptLanguage: language,
    insecureTls,
    readOnly,
    elicitation,
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
