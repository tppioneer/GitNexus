export interface ParsedCseUrl {
  appId?: string;
  serviceRef: string;
  pathTemplate: string;
  queryTemplate?: string;
  queryParamNames: string[];
}

const PARAM_TOKEN = '{param}';

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

export function joinRoutePath(prefix: string | null | undefined, methodPath: string): string {
  const left = (prefix ?? '').trim();
  const right = methodPath.trim();
  if (!left) return normalizePathTemplate(right);
  if (!right) return normalizePathTemplate(left);
  return normalizePathTemplate(`${left.replace(/\/+$/g, '')}/${right.replace(/^\/+/g, '')}`);
}

export function parseCseUrl(raw: string): ParsedCseUrl | null {
  const trimmed = raw.trim();
  const match = /^cse:\/\/([^/?#]+)(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(trimmed);
  if (!match) return null;

  const authority = match[1] ?? '';
  const path = match[2] ?? '/';
  const query = match[3];
  if (!authority || authority.includes('%s') || /\{[^}]+\}/.test(authority)) return null;

  const colonIdx = authority.indexOf(':');
  const appId = colonIdx > 0 ? authority.slice(0, colonIdx) : undefined;
  const serviceRef = colonIdx > 0 ? authority.slice(colonIdx + 1) : authority;
  if (!serviceRef || serviceRef.includes(':')) return null;

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
