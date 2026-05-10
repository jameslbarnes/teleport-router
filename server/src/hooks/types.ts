/**
 * Hook System Types
 *
 * Hooks replace the poll-based agent model. Events from the notebook
 * and platforms are dispatched to registered handlers in real time.
 */

import type { RouterEvent } from '../events.js';
import type { Storage } from '../storage.js';
import type { Platform } from '../platform/types.js';

export type HookTrigger =
  | 'entry_staged'
  | 'entry_published'
  | 'entry_held'
  | 'platform_message'
  | 'platform_mention'
  | 'platform_onboarding'
  | 'daily_digest_requested'
  | 'cron';

export interface HookContext {
  trigger: HookTrigger;
  event: RouterEvent;
  storage: Storage;
  platforms: Platform[];
}

export type HookHandler = (ctx: HookContext) => Promise<void>;

export interface HookRegistration {
  id: string;
  triggers: HookTrigger[];
  handler: HookHandler;
  priority?: number; // lower = runs first, default 100
}
