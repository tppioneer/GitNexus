/**
 * Java + Spring MVC capability detection for the CSE-link plugin.
 *
 * Determines whether a repo is eligible for CSE analysis. A repo must:
 *   1. Contain at least one `.java` source file.
 *   2. Show evidence of Spring MVC framework usage:
 *      - Maven/Gradle dependency on Spring Web or Spring Boot Starter Web.
 *      - Java source imports of Spring MVC/RestTemplate types.
 *      - Java source usage of Spring Controller mapping annotations.
 *
 * I/O and glob errors PROPAGATE (do not catch here) — the caller
 * distinguishes "no capability" (normal, return false) from "cannot
 * determine" (thrown, enters failedRepos).
 *
 * Repository names or directory names are NOT used as evidence.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Build file patterns that may contain Spring dependency evidence.
 * Matched at any depth via the file list from the caller.
 */
const BUILD_FILE_PATTERNS = [
  /pom\.xml$/i,
  /build\.gradle(?:\.kts)?$/i,
];

/**
 * Patterns in build files that indicate Spring Web dependency.
 */
const SPRING_BUILD_PATTERNS = [
  /spring-web/i,
  /spring-boot-starter-web/i,
  /org\.springframework\.boot/i,
];

/**
 * Java import patterns that indicate Spring MVC usage.
 */
const SPRING_IMPORT_PATTERNS = [
  /import\s+org\.springframework\.web\./,
  /import\s+org\.springframework\.stereotype\.(RestController|Controller)/,
  /import\s+org\.springframework\.web\.client\.RestTemplate/,
];

/**
 * Annotation patterns that indicate Spring Controller usage.
 */
const SPRING_ANNOTATION_PATTERNS = [
  /@(?:RestController|Controller)\b/,
  /@RequestMapping\b/,
  /@(?:Get|Post|Put|Delete|Patch)Mapping\b/,
];

/**
 * Check whether a repo has Java + Spring MVC capability.
 *
 * @param repoPath - Absolute path to the repo root (unused but kept for API stability).
 * @param files - Repo-relative file paths, already obtained via glob with
 *   ignore rules applied. Must include both `.java` files and build files
 *   (`pom.xml`, `build.gradle`, `build.gradle.kts`) at any depth.
 * @returns true if the repo has Java files AND at least one Spring MVC signal.
 * @throws {Error} if a build file or Java file cannot be read (caller catches).
 */
export function hasJavaSpringCapability(repoPath: string, files: readonly string[]): boolean {
  const javaFiles = files.filter((f) => f.endsWith('.java'));
  if (javaFiles.length === 0) return false;

  // Check build files (pom.xml, build.gradle, build.gradle.kts at any depth).
  for (const rel of files) {
    if (BUILD_FILE_PATTERNS.some((re) => re.test(rel))) {
      const content = fs.readFileSync(path.join(repoPath, rel), 'utf-8');
      if (SPRING_BUILD_PATTERNS.some((re) => re.test(content))) return true;
    }
  }

  // Check Java source files for Spring imports or annotations.
  for (const rel of javaFiles) {
    const content = fs.readFileSync(path.join(repoPath, rel), 'utf-8');
    if (SPRING_IMPORT_PATTERNS.some((re) => re.test(content))) return true;
    if (SPRING_ANNOTATION_PATTERNS.some((re) => re.test(content))) return true;
  }

  return false;
}
