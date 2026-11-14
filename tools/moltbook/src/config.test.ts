import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskKey, primaryCredentialsPath, resolveCredentials, saveCredentials } from './config.ts';
import { parseArgs } from './cli.ts';

const ENV_KEYS = ['MOLTBOOK_CONFIG_DIR', 'MOLTBOOK_API_KEY', 'MOLTBOOK_AGENT_NAME'] as const;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.MOLTBOOK_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'moltbook-test-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('credential resolution', () => {
  it('prefers an explicit key over everything else', async () => {
    process.env.MOLTBOOK_API_KEY = 'moltbook_env';
    const resolved = await resolveCredentials('moltbook_explicit');
    expect(resolved).toMatchObject({ api_key: 'moltbook_explicit', source: 'argument' });
  });

  it('falls back to the environment', async () => {
    process.env.MOLTBOOK_API_KEY = 'moltbook_env';
    const resolved = await resolveCredentials();
    expect(resolved).toMatchObject({ api_key: 'moltbook_env', source: 'env' });
  });

  it('round-trips the credentials file with 0600 permissions', async () => {
    const path = await saveCredentials({ api_key: 'moltbook_file', agent_name: 'Osiris' });
    expect(path).toBe(primaryCredentialsPath());

    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);

    const resolved = await resolveCredentials();
    expect(resolved).toMatchObject({ api_key: 'moltbook_file', agent_name: 'Osiris', source: 'file' });
    expect(resolved?.created_at).toBeTruthy();
  });

  it('returns nothing when no credentials exist anywhere', async () => {
    expect(await resolveCredentials()).toBeUndefined();
  });
});

describe('maskKey', () => {
  it('keeps only enough to identify the key', () => {
    expect(maskKey('moltbook_abcdefghijklmnop')).toBe('moltbook_abc…nop');
    expect(maskKey('short')).toBe('***');
  });
});

describe('CLI argument parsing', () => {
  it('separates positionals, value flags and booleans', () => {
    const ctx = parseArgs(['post', 'My title', '--submolt', 'general', '--json']);
    expect(ctx.positional).toEqual(['post', 'My title']);
    expect(ctx.flags.values.submolt).toBe('general');
    expect(ctx.flags.json).toBe(true);
  });

  it('accepts --flag=value form', () => {
    const ctx = parseArgs(['search', 'memory', '--limit=5']);
    expect(ctx.flags.values.limit).toBe('5');
  });

  it('rejects a value flag with no value', () => {
    expect(() => parseArgs(['post', 'x', '--submolt', '--json'])).toThrow(/needs a value/);
  });

  it('treats everything after -- as positional', () => {
    const ctx = parseArgs(['comment', 'p1', '--', '--not-a-flag']);
    expect(ctx.positional).toEqual(['comment', 'p1', '--not-a-flag']);
  });
});
