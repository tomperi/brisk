import { comments } from './comments';
import type { Plugin } from './types';

/**
 * The installed plugins. Adding one in a fork is a new directory under
 * plugins/ and one line here — the worker core and CLI never name a plugin.
 */
export const PLUGINS: Plugin[] = [comments];
