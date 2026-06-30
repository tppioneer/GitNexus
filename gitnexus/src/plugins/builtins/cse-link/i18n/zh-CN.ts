/**
 * CSE-link plugin Chinese (Simplified) i18n resources.
 */

import type { en } from './en.js';

type Messages = Record<keyof typeof en, string>;

export const zhCN: Messages = {
  displayName: 'CSE 链接分析',
  description: '从 Java Spring 项目中提取 CSE 微服务 HTTP 调用合同。',
  missingServiceName:
    '仓库 {{repo}} 中没有找到唯一明确的 service_description.name。',
  ambiguousServiceName:
    '仓库 {{repo}} 中存在多个 service_description.name：{{names}}。',
  unresolvedCseUrl: '无法解析 {{file}}:{{line}} 中的 CSE URL。',
  unresolvedExternalConstant:
    '无法解析类 {{class}} 中的外部常量 {{constant}}。',
  unsupportedRestTemplateCall:
    '{{file}}:{{line}} 中的 RestTemplate 调用形式不受支持。',
  unresolvedControllerPrefix:
    '无法解析 {{file}} 中的类级 @RequestMapping 前缀。',
  ambiguousProviderMatch:
    '{{file}}:{{line}} 处 consumer 的 {{contractId}} 存在多个 provider 匹配。',
  expansionLimitExceeded:
    '{{file}}:{{line}} 中的 mapping 展开数量超过上限（{{limit}}）。',
  testSourceRootInvalid:
    '无效的测试源根「{{root}}」：必须是不含「..」的相对目录。',
  fileParseFailed: '无法解析 {{file}}。',
  pluginExtractionFailed: '仓库 {{repo}} 提取失败：{{error}}。',
  rulesInvalid: '仓库 {{repo}} 的 microservice-rules.yaml 无效：{{error}}。',
  noApplicableRepositories: 'group 中没有仓库满足 Java + Spring MVC 能力条件。',
  suppressed: '仓库 {{repo}} 中有 {{count}} 条诊断被抑制（上限 {{limit}}）。',
  summary:
    'CSE 链接分析：{{repos}} 个仓库中发现 {{providers}} 个 provider、{{consumers}} 个 consumer。',
};
