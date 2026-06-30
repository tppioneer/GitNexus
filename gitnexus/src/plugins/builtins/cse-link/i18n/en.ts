/**
 * CSE-link plugin English i18n resources.
 */

export const en = {
  displayName: 'CSE Link',
  description: 'Extract CSE microservice HTTP contracts from Java Spring projects.',
  missingServiceName:
    'No unambiguous service_description.name was found in {{repo}}.',
  ambiguousServiceName:
    'Multiple service_description.name values were found in {{repo}}: {{names}}.',
  unresolvedCseUrl: 'Could not resolve CSE URL in {{file}}:{{line}}.',
  unresolvedExternalConstant:
    'Could not resolve external constant {{constant}} in class {{class}}.',
  unsupportedRestTemplateCall:
    'Unsupported RestTemplate call form in {{file}}:{{line}}.',
  unresolvedControllerPrefix:
    'Could not resolve class-level @RequestMapping prefix in {{file}}.',
  ambiguousProviderMatch:
    'Multiple providers match consumer at {{file}}:{{line}} for {{contractId}}.',
  expansionLimitExceeded:
    'Mapping expansion limit ({{limit}}) exceeded in {{file}}:{{line}}.',
  testSourceRootInvalid:
    'Invalid test source root "{{root}}": must be a relative directory without "..".',
  fileParseFailed: 'Failed to parse {{file}}.',
  pluginExtractionFailed: 'Extraction failed for {{repo}}: {{error}}.',
  rulesInvalid: 'Invalid microservice-rules.yaml in {{repo}}: {{error}}.',
  noApplicableRepositories:
    'No repositories in the group have Java + Spring MVC capability.',
  suppressed:
    '{{count}} additional diagnostics suppressed for {{repo}} (limit {{limit}}).',
  summary:
    'CSE-link: {{providers}} providers, {{consumers}} consumers from {{repos}} repos.',
} as const;

export type CseLinkMessageKey = keyof typeof en;
