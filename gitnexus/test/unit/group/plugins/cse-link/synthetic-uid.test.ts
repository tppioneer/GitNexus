import { describe, it, expect } from 'vitest';
import { generateSyntheticUid } from '../../../../../src/plugins/builtins/cse-link/synthetic-uid.js';

describe('generateSyntheticUid', () => {
  it('generates stable UID for same input', () => {
    const input = {
      pluginId: 'cse-link',
      role: 'consumer' as const,
      filePath: 'src/main/java/com/acme/OrderClient.java',
      enclosingMethod: 'queryOrder',
      httpMethod: 'GET',
      normalizedPath: '/rest/orders/{param}',
      serviceIdentity: 'order-service',
    };
    const uid1 = generateSyntheticUid(input);
    const uid2 = generateSyntheticUid(input);
    expect(uid1).toBe(uid2);
  });

  it('prefix reflects role', () => {
    const base = {
      pluginId: 'cse-link',
      filePath: 'src/File.java',
      httpMethod: 'GET',
      normalizedPath: '/api',
      serviceIdentity: 'svc',
    };
    expect(generateSyntheticUid({ ...base, role: 'consumer' })).toMatch(/^CseLinkConsumer:/);
    expect(generateSyntheticUid({ ...base, role: 'provider' })).toMatch(/^CseLinkProvider:/);
  });

  it('different service identity produces different UID', () => {
    const base = {
      pluginId: 'cse-link',
      role: 'consumer' as const,
      filePath: 'src/File.java',
      httpMethod: 'GET',
      normalizedPath: '/api',
    };
    const uid1 = generateSyntheticUid({ ...base, serviceIdentity: 'svc-a' });
    const uid2 = generateSyntheticUid({ ...base, serviceIdentity: 'svc-b' });
    expect(uid1).not.toBe(uid2);
  });

  it('different method produces different UID', () => {
    const base = {
      pluginId: 'cse-link',
      role: 'consumer' as const,
      filePath: 'src/File.java',
      normalizedPath: '/api',
      serviceIdentity: 'svc',
    };
    const uid1 = generateSyntheticUid({ ...base, httpMethod: 'GET' });
    const uid2 = generateSyntheticUid({ ...base, httpMethod: 'POST' });
    expect(uid1).not.toBe(uid2);
  });

  it('Windows and POSIX paths produce same UID', () => {
    const uid1 = generateSyntheticUid({
      pluginId: 'cse-link',
      role: 'consumer',
      filePath: 'src/main/java/com/acme/File.java',
      httpMethod: 'GET',
      normalizedPath: '/api',
      serviceIdentity: 'svc',
    });
    const uid2 = generateSyntheticUid({
      pluginId: 'cse-link',
      role: 'consumer',
      filePath: 'src\\main\\java\\com\\acme\\File.java',
      httpMethod: 'GET',
      normalizedPath: '/api',
      serviceIdentity: 'svc',
    });
    expect(uid1).toBe(uid2);
  });
});
