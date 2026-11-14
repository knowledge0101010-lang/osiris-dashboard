/**
 * Registers the alias/extension resolver before the CLI entry loads.
 * Used as: node --import ./tools/wiki/src/register.mjs tools/wiki/src/run.ts
 */

import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
