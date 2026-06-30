import { describe, it, expect } from 'vitest';
import { isTestSourcePath } from '../../../../../src/plugins/builtins/cse-link/test-source-filter.js';

describe('isTestSourcePath', () => {
  it('filters src/test/ paths', () => {
    expect(isTestSourcePath('src/test/java/com/acme/OrderTest.java')).toBe(true);
  });

  it('filters src/integrationTest/ paths', () => {
    expect(isTestSourcePath('src/integrationTest/java/com/acme/ITOrder.java')).toBe(true);
  });

  it('filters src/functionalTest/ paths', () => {
    expect(isTestSourcePath('src/functionalTest/java/com/acme/FTOrder.java')).toBe(true);
  });

  it('filters top-level test/ and tests/', () => {
    expect(isTestSourcePath('test/com/acme/OrderTest.java')).toBe(true);
    expect(isTestSourcePath('tests/com/acme/OrderTest.java')).toBe(true);
  });

  it('does not filter production source paths', () => {
    expect(isTestSourcePath('src/main/java/com/acme/OrderClient.java')).toBe(false);
  });

  it('does not filter src/main/.../test/ package paths', () => {
    // Production package named "test" should NOT be filtered
    expect(isTestSourcePath('src/main/java/com/acme/test/OrderClient.java')).toBe(false);
  });

  it('does not filter directories containing "test" as substring', () => {
    expect(isTestSourcePath('src/main/java/com/acme/contest/Order.java')).toBe(false);
    expect(isTestSourcePath('src/main/java/com/acme/latest/Order.java')).toBe(false);
  });

  it('handles Windows paths', () => {
    expect(isTestSourcePath('src\\test\\java\\com\\acme\\OrderTest.java')).toBe(true);
    expect(isTestSourcePath('src\\main\\java\\com\\acme\\Order.java')).toBe(false);
  });

  it('does not filter by class name alone', () => {
    // Class name ending in Test but in production source should NOT be filtered
    expect(isTestSourcePath('src/main/java/com/acme/OrderClientTest.java')).toBe(false);
  });

  it('supports custom test source roots', () => {
    expect(isTestSourcePath('src/componentTest/java/com/acme/Order.java', ['src/componentTest'])).toBe(true);
  });

  it('filters test source-set fixtures and mocks', () => {
    expect(isTestSourcePath('src/test/java/com/acme/MockOrderClient.java')).toBe(true);
    expect(isTestSourcePath('tests/com/acme/CseTestSupport.java')).toBe(true);
  });

  it('filters nested module test source paths (multi-module Maven/Gradle)', () => {
    // `code/webapp/src/test/...` is a standard Spring Boot monorepo layout
    expect(isTestSourcePath('code/webapp/src/test/java/com/acme/OrderTest.java')).toBe(true);
    // `module-a/src/integrationTest/...` is a standard Gradle multi-module layout
    expect(isTestSourcePath('module-a/src/integrationTest/java/com/acme/ITOrder.java')).toBe(true);
    // `module-a/src/test/...` at any depth
    expect(isTestSourcePath('module-a/src/test/java/com/acme/OrderTest.java')).toBe(true);
    // Functional test under nested module
    expect(isTestSourcePath('services/order/src/functionalTest/java/com/acme/FT.java')).toBe(true);
  });

  it('custom root uses segment-boundary matching (not prefix)', () => {
    // `src/componentTest` is a custom root; exact match works
    expect(isTestSourcePath('src/componentTest/Order.java', ['src/componentTest'])).toBe(true);
    expect(isTestSourcePath('src/componentTest/sub/Order.java', ['src/componentTest'])).toBe(true);
    // `src/componentTesting/...` must NOT be falsely filtered
    expect(isTestSourcePath('src/componentTesting/Order.java', ['src/componentTest'])).toBe(false);
    // `componentTest/...` at any depth
    expect(isTestSourcePath('module-a/src/componentTest/Order.java', ['src/componentTest'])).toBe(false);
  });

  it('rejects absolute and traversal custom roots', () => {
    // Use a non-default-test path so the only way to match is via the
    // (invalid) custom root. Invalid roots must be ignored, leaving the
    // file NOT classified as a test source.
    expect(isTestSourcePath('src/main/Order.java', ['/abs/path'])).toBe(false);
    expect(isTestSourcePath('src/main/Order.java', ['../escape'])).toBe(false);
  });
});
