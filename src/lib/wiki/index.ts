/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Intel Wiki
 *  Public surface. Import from '@/lib/wiki'.
 * ═══════════════════════════════════════════════════════════════
 */

export {
  DEFAULT_WIKI_DIR,
  WikiStore,
  contentHash,
  isStale,
  parse,
  serialize,
  slugify,
  type StalenessPolicy,
  type WikiStoreOptions,
  type WriteOutcome,
  type WriteResult,
} from './store';
export {
  DEFAULT_POLICY,
  WIKI_SYSTEM_PROMPT,
  buildPrompt,
  runWikiLoop,
  type LoopReport,
  type TopicOutcome,
  type WikiLoopOptions,
} from './loop';
export { deriveTopics, type DeriveOptions } from './topics';
export {
  GENERATED_ENTRY_SCHEMA,
  type Confidence,
  type GeneratedEntry,
  type Signal,
  type Topic,
  type WikiEntry,
  type WikiMeta,
  type WikiSource,
} from './types';
