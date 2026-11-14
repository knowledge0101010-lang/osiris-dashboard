/**
 * Credential resolution and storage.
 *
 * Resolution order (first hit wins):
 *   1. explicit `--api-key` / constructor argument
 *   2. MOLTBOOK_API_KEY environment variable
 *   3. $MOLTBOOK_CONFIG_DIR/credentials.json
 *   4. ~/.config/moltbook/credentials.json   (the location the skill recommends)
 *   5. ~/.moltbot/credentials.json           (legacy moltbot layout)
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_API_BASE, MoltbookClient } from './client.ts';

export interface Credentials {
  api_key: string;
  agent_name?: string;
  claim_url?: string;
  verification_code?: string;
  created_at?: string;
}

export interface ResolvedCredentials extends Credentials {
  /** Where the key came from, for `moltbook doctor`. */
  source: 'argument' | 'env' | 'file';
  path?: string;
}

export function primaryCredentialsPath(): string {
  const override = process.env.MOLTBOOK_CONFIG_DIR;
  if (override) return join(override, 'credentials.json');
  return join(homedir(), '.config', 'moltbook', 'credentials.json');
}

function candidatePaths(): string[] {
  const paths = [primaryCredentialsPath()];
  const legacy = join(homedir(), '.moltbot', 'credentials.json');
  if (!paths.includes(legacy)) paths.push(legacy);
  return paths;
}

async function readCredentialsFile(path: string): Promise<Credentials | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    if (typeof parsed.api_key === 'string' && parsed.api_key) {
      return parsed as Credentials;
    }
  } catch {
    // Fall through: a corrupt file is treated as "no credentials here".
  }
  return undefined;
}

export async function resolveCredentials(explicitKey?: string): Promise<ResolvedCredentials | undefined> {
  if (explicitKey) {
    return { api_key: explicitKey, source: 'argument' };
  }
  const fromEnv = process.env.MOLTBOOK_API_KEY;
  if (fromEnv) {
    return { api_key: fromEnv, agent_name: process.env.MOLTBOOK_AGENT_NAME, source: 'env' };
  }
  for (const path of candidatePaths()) {
    const found = await readCredentialsFile(path);
    if (found) return { ...found, source: 'file', path };
  }
  return undefined;
}

/** Writes credentials with 0600 permissions (0700 on the directory). */
export async function saveCredentials(credentials: Credentials): Promise<string> {
  const path = primaryCredentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload: Credentials = { created_at: new Date().toISOString(), ...credentials };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export function resolveBaseUrl(explicitBase?: string): string {
  return explicitBase ?? process.env.MOLTBOOK_API_BASE ?? DEFAULT_API_BASE;
}

export function allowUntrustedHost(): boolean {
  return process.env.MOLTBOOK_ALLOW_UNTRUSTED_HOST === '1';
}

export interface ClientContext {
  client: MoltbookClient;
  credentials?: ResolvedCredentials;
}

/**
 * Builds a client from the ambient environment. Missing credentials are not an
 * error here — anonymous registration and `doctor` both need a client anyway.
 */
export async function createClient(
  options: { apiKey?: string; baseUrl?: string } = {},
): Promise<ClientContext> {
  const credentials = await resolveCredentials(options.apiKey);
  const client = new MoltbookClient({
    apiKey: credentials?.api_key,
    baseUrl: resolveBaseUrl(options.baseUrl),
    allowUntrustedHost: allowUntrustedHost(),
  });
  return { client, credentials };
}

/** `moltbook_abc123def456` -> `moltbook_abc…456` */
export function maskKey(key: string): string {
  if (key.length <= 12) return '***';
  return `${key.slice(0, 12)}…${key.slice(-3)}`;
}
