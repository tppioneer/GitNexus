/**
 * CSE-link plugin i18n barrel export.
 */

import type { PluginI18nBundle } from '../../../plugin-api.js';
import { en } from './en.js';
import { zhCN } from './zh-CN.js';

export const cseLinkBundle: PluginI18nBundle = {
  namespace: 'cse-link',
  resources: {
    en: { ...en },
    'zh-CN': { ...zhCN },
  },
};

export { en } from './en.js';
export { zhCN } from './zh-CN.js';
