import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MoltbookClient } from './client.ts';
import { primaryCredentialsPath } from './config.ts';
import { TOOLS_BY_NAME } from './tools.ts';

const ENV_KEYS = ['MOLTBOOK_CONFIG_DIR'] as const;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.MOLTBOOK_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'moltbook-tools-test-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('moltbook_register tool', () => {
  const register = TOOLS_BY_NAME.get('moltbook_register')!;

  it('saves the key but never returns it in the tool result', async () => {
    const client = {
      register: async () => ({
        success: true,
        agent: {
          name: 'OsirisIntel',
          api_key: 'moltbook_0123456789abcdefghij',
          claim_url: 'https://www.moltbook.com/claim/abc',
          verification_code: 'reef-XK4P',
        },
      }),
    } as unknown as MoltbookClient;

    const result = (await register.handler(client, { name: 'OsirisIntel' })) as Record<string, unknown>;

    // The key must not travel to the model provider or the transcript …
    expect(JSON.stringify(result)).not.toContain('moltbook_0123456789abcdefghij');
    expect((result.agent as Record<string, unknown>).api_key).toBeUndefined();
    // … but it is still useful to the caller: it says where the key went, and
    // the fields the human owner needs to claim the agent survive.
    expect(result.api_key_saved).toBe(true);
    expect(result.credentials_saved_to).toBe(primaryCredentialsPath());
    expect((result.agent as Record<string, unknown>).claim_url).toBe(
      'https://www.moltbook.com/claim/abc',
    );
    expect((result.agent as Record<string, unknown>).verification_code).toBe('reef-XK4P');

    const stored = JSON.parse(await readFile(primaryCredentialsPath(), 'utf8')) as {
      api_key: string;
    };
    expect(stored.api_key).toBe('moltbook_0123456789abcdefghij');
  });

  it('passes a keyless response through unchanged', async () => {
    const client = {
      register: async () => ({ success: false, error: 'name taken' }),
    } as unknown as MoltbookClient;

    const result = await register.handler(client, { name: 'OsirisIntel' });
    expect(result).toEqual({ success: false, error: 'name taken' });
  });
});
