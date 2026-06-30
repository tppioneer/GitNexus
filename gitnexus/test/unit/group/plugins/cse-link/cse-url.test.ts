import { describe, it, expect } from 'vitest';
import { parseCseUrl, normalizePathTemplate, joinRoutePath } from '../../../../../src/plugins/builtins/cse-link/cse-url.js';

describe('parseCseUrl', () => {
  it('parses simple cse:// URL', () => {
    const result = parseCseUrl('cse://order-service/rest/v1/orders/{id}');
    expect(result).not.toBeNull();
    expect(result!.serviceRef).toBe('order-service');
    expect(result!.appId).toBeUndefined();
    expect(result!.pathTemplate).toBe('/rest/v1/orders/{param}');
    expect(result!.queryTemplate).toBeUndefined();
  });

  it('parses cse:// URL with appId:serviceRef', () => {
    const result = parseCseUrl('cse://platform:order-service/rest/orders?id=%s');
    expect(result).not.toBeNull();
    expect(result!.appId).toBe('platform');
    expect(result!.serviceRef).toBe('order-service');
    expect(result!.pathTemplate).toBe('/rest/orders');
    expect(result!.queryTemplate).toBe('id=%s');
    expect(result!.queryParamNames).toEqual(['id']);
  });

  it('returns null for non-CSE URL', () => {
    expect(parseCseUrl('http://example.com/api')).toBeNull();
    expect(parseCseUrl('https://example.com/api')).toBeNull();
  });

  it('returns null for URL with dynamic authority', () => {
    expect(parseCseUrl('cse://%s/rest/api')).toBeNull();
    expect(parseCseUrl('cse://{service}/rest/api')).toBeNull();
  });

  it('normalizes %s to {param}', () => {
    const result = parseCseUrl('cse://svc/api/%s/data');
    expect(result!.pathTemplate).toBe('/api/{param}/data');
  });

  it('handles empty path', () => {
    const result = parseCseUrl('cse://svc');
    expect(result).not.toBeNull();
    expect(result!.pathTemplate).toBe('/');
  });

  it('rejects port-like suffix in authority (issue #7)', () => {
    // `cse://svc:8080/path` must NOT be parsed as appId=svc, serviceRef=8080.
    expect(parseCseUrl('cse://svc:8080/path')).toBeNull();
    expect(parseCseUrl('cse://platform:order-svc:8080/path')).toBeNull();
  });

  it('rejects authorities with non-identifier characters', () => {
    expect(parseCseUrl('cse://svc with space/path')).toBeNull();
    expect(parseCseUrl('cse://svc!@#/path')).toBeNull();
  });
});

describe('normalizePathTemplate', () => {
  it('collapses path parameters', () => {
    expect(normalizePathTemplate('/api/users/:id')).toBe('/api/users/{param}');
    expect(normalizePathTemplate('/api/{userId}/orders')).toBe('/api/{param}/orders');
    expect(normalizePathTemplate('/api/%s')).toBe('/api/{param}');
  });

  it('strips trailing slash', () => {
    expect(normalizePathTemplate('/api/orders/')).toBe('/api/orders');
  });

  it('adds leading slash', () => {
    expect(normalizePathTemplate('api/orders')).toBe('/api/orders');
  });
});

describe('joinRoutePath', () => {
  it('joins prefix and method path', () => {
    expect(joinRoutePath('/rest/v1', '/orders')).toBe('/rest/v1/orders');
  });

  it('handles null prefix', () => {
    expect(joinRoutePath(null, '/orders')).toBe('/orders');
  });

  it('handles empty method path', () => {
    expect(joinRoutePath('/rest', '')).toBe('/rest');
  });
});
