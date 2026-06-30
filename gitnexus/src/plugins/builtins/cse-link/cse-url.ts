/**
 * CSE URL parsing and path normalization.
 *
 * Handles `cse://<serviceRef>/...` and `cse://<appId>:<serviceRef>/...`
 * URL forms. Extracts serviceRef, appId, path template, and query
 * template. Used by the CSE-link plugin for consumer contract extraction.
 */

export interface ParsedCseUrl {
  appId?: string;
  serviceRef: string;
  pathTemplate: string;
  queryTemplate?: string;
  queryParamNames: string[];
}

const PARAM_TOKEN = '{param}';

/**
 * Normalize a path template for contract ID generation:
 *   - strip query string and fragment
 *   - collapse consecutive slashes
 *   - normalize `%s`, `{name}`, `:name` to `{param}`
 */
export function normalizePathTemplate(raw: string): string {
  const withoutQuery = raw.trim().split(/[?#]/, 1)[0] ?? '';
  let path = withoutQuery.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/+$/g, '');
  if (path === '') path = '/';

  const segments = path
    .split('/')
    .map((segment) => {
      if (segment === '%s') return PARAM_TOKEN;
      if (/^\{[^}]+\}$/.test(segment)) return PARAM_TOKEN;
      if (/^:[A-Za-z_][\w$-]*$/.test(segment)) return PARAM_TOKEN;
      return segment;
    })
    .join('/');
  return segments || '/';
}

/**
 * Join a class-level prefix and a method-level path.
 */
export function joinRoutePath(prefix: string | null | undefined, methodPath: string): string {
  const left = (prefix ?? '').trim();
  const right = methodPath.trim();
  if (!left) return normalizePathTemplate(right);
  if (!right) return normalizePathTemplate(left);
  return normalizePathTemplate(`${left.replace(/\/+$/g, '')}/${right.replace(/^\/+/g, '')}`);
}

/**
 * Parse a `cse://` URL into its components. Returns null for non-CSE URLs
 * or URLs with unresolvable dynamic authority.
 *
 * Authority is restricted to a single optional `appId:` prefix followed
 * by an alphanumeric identifier. This rejects authority strings that
 * contain arbitrary characters (e.g. `cse://svc:8080/path` is not a valid
 * CSE URL — port-like suffixes would mis-resolve into serviceRef).
 */
const CSE_ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseCseUrl(raw: string): ParsedCseUrl | null {
  const trimmed = raw.trim();
  const match = /^cse:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(trimmed);
  if (!match) return null;

  const authority = match[1] ?? '';
  const path = match[2] ?? '/';
  const query = match[3];
  if (!authority || authority.includes('%s') || /\{[^}]+\}/.test(authority)) return null;

  const colonIdx = authority.indexOf(':');
  const appIdRaw = colonIdx > 0 ? authority.slice(0, colonIdx) : undefined;
  const serviceRefRaw = colonIdx > 0 ? authority.slice(colonIdx + 1) : authority;

  // Reject if either part is not a valid identifier — prevents port-like
  // or otherwise malformed authorities from being mis-parsed.
  if (serviceRefRaw.includes(':')) return null;
  if (appIdRaw !== undefined && !CSE_ID_RE.test(appIdRaw)) return null;
  if (!CSE_ID_RE.test(serviceRefRaw)) return null;

  const appId = appIdRaw;
  const serviceRef = serviceRefRaw;

  const queryParamNames =
    query === undefined || query.length === 0
      ? []
      : query
          .split('&')
          .map((part) => part.split('=', 1)[0] ?? '')
          .filter((name) => name.length > 0)
          .map((name) => {
            try {
              return decodeURIComponent(name);
            } catch {
              return name;
            }
          });

  return {
    ...(appId ? { appId } : {}),
    serviceRef,
    pathTemplate: normalizePathTemplate(path),
    ...(query !== undefined ? { queryTemplate: query } : {}),
    queryParamNames,
  };
}
