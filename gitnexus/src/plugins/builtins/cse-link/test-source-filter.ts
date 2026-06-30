/**
 * Test source-set filter for CSE-link plugin.
 *
 * Filters out test source directories so test-only CSE calls do not
 * generate production consumer contracts or cross-links.
 *
 * Matching is restricted to the well-known test source-root layouts:
 *   - `<any-path>/src/test/...`
 *   - `<any-path>/src/integrationTest/...`
 *   - `<any-path>/src/functionalTest/...`
 *   - `<repo-root>/test/...`
 *   - `<repo-root>/tests/...`
 *
 * The `src/test`-style roots may appear at any depth in the file path
 * (multi-module Maven/Gradle layouts such as `module-a/src/test/java/`
 * or `code/webapp/src/test/java/` are supported). The `test/` and
 * `tests/` roots match only at the repo root — they do not match
 * `<any-path>/submodule/test/...` (covered by `src/test` Pass 1 instead).
 *
 * Does NOT filter based on class names (e.g. `*Test.java`) or arbitrary
 * path segments named "test" (e.g. `com/acme/test/`).
 */

/**
 * Source-set name segments that match when immediately preceded by a
 * `src/` segment. Multi-module repos like `module-a/src/test` match this
 * rule because the path-segment `test` follows a `src` segment.
 */
const SRC_TEST_SEGMENTS = new Set<string>([
  'test',
  'integrationtest',
  'functionaltest',
]);

/**
 * Top-level test directories that match only at repo root.
 */
const REPO_ROOT_TEST_DIRS = new Set<string>(['test', 'tests']);

/**
 * Normalize a repo-relative path: forward slashes only, lowercase,
 * no leading `./` or repeated `/`.
 */
function normalizePath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/');
}

/**
 * Check if a file path falls within a test source set.
 *
 * @param filePath - Repo-relative file path.
 * @param extraRoots - Additional test source roots from microservice-rules.yaml.
 *   Each root is a repo-relative directory (e.g. `module-a/src/componentTest`).
 *   Matched at full path-segment boundary; `src/componentTest` does not
 *   match `src/componentTesting/...`.
 */
export function isTestSourcePath(filePath: string, extraRoots?: readonly string[]): boolean {
  const normalized = normalizePath(filePath);
  if (!normalized) return false;
  const segments = normalized.split('/').filter(Boolean);

  // Pass 1: `<any>/src/<test-segment>/...`
  //   - `src/test/...`, `code/webapp/src/test/...`,
  //     `module-a/src/integrationTest/...` all match.
  //   - A bare `test` segment NOT preceded by `src` (e.g. `com/acme/test`)
  //     is NOT matched here.
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'src' && SRC_TEST_SEGMENTS.has(segments[i + 1] ?? '')) {
      return true;
    }
  }

  // Pass 2: top-level `test/` or `tests/` at repo root.
  //   - `test/OrderTest.java` matches.
  //   - `submodule/test/OrderTest.java` does NOT match here (the `src/test`
  //     path inside the submodule would match via Pass 1 if applicable).
  if (segments[0] && REPO_ROOT_TEST_DIRS.has(segments[0])) {
    return true;
  }

  // Pass 3: user-supplied extraRoots. Each root is matched at path-segment
  // boundary. `src/componentTest` matches `src/componentTest/...` but NOT
  // `src/componentTesting/...` (different next segment).
  if (extraRoots) {
    for (const rawRoot of extraRoots) {
      const root = normalizePath(rawRoot);
      if (!root) continue;
      if (root.startsWith('/') || root.includes('..')) continue;
      const rootSegments = root.split('/').filter(Boolean);
      if (rootSegments.length === 0) continue;
      if (segments.length < rootSegments.length) continue;
      let matched = true;
      for (let i = 0; i < rootSegments.length; i++) {
        if (segments[i] !== rootSegments[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }

  return false;
}
