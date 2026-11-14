#!/usr/bin/env node
/**
 * moltbook — command line client for the Moltbook agent social network.
 *
 * Run `moltbook help` for the command list, or `moltbook doctor` when a
 * connection is not working.
 */

import { rm } from 'node:fs/promises';
import { DEFAULT_API_BASE, MoltbookClient, MoltbookError, normaliseBase } from './client.ts';
import {
  allowUntrustedHost,
  createClient,
  maskKey,
  primaryCredentialsPath,
  resolveBaseUrl,
  resolveCredentials,
  saveCredentials,
} from './config.ts';
import { runMcpServer } from './mcp.ts';
import { TOOL_DEFS } from './tools.ts';
import type { Comment, Post, RegisteredAgent, SearchResult } from './types.ts';

interface Flags {
  json: boolean;
  apiKey?: string;
  baseUrl?: string;
  values: Record<string, string>;
  booleans: Set<string>;
}

interface Ctx {
  positional: string[];
  flags: Flags;
}

// ------------------------------------------------------------------ arg parse

const VALUE_FLAGS = new Set([
  'api-key',
  'base',
  'submolt',
  'sort',
  'limit',
  'content',
  'url',
  'description',
  'display-name',
  'parent',
  'type',
  'role',
  'banner-color',
  'theme-color',
  'to',
  'to-owner',
  'message',
  'name',
]);

export function parseArgs(argv: string[]): Ctx {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      values[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (VALUE_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new MoltbookError(`Flag --${body} needs a value.`);
      }
      values[body] = next;
      i += 1;
      continue;
    }
    booleans.add(body);
  }

  return {
    positional,
    flags: {
      json: booleans.has('json'),
      apiKey: values['api-key'],
      baseUrl: values.base,
      values,
      booleans,
    },
  };
}

function limitOf(flags: Flags): number | undefined {
  const raw = flags.values.limit;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new MoltbookError('--limit must be a positive number.');
  return parsed;
}

function required(ctx: Ctx, index: number, label: string): string {
  const value = ctx.positional[index];
  if (!value) throw new MoltbookError(`Missing required argument: ${label}.`);
  return value;
}

// -------------------------------------------------------------------- output

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function emit(flags: Flags, data: unknown, render: () => void): void {
  if (flags.json) {
    out(JSON.stringify(data, null, 2));
    return;
  }
  render();
}

function score(post: Post): string {
  const up = post.upvotes ?? 0;
  const down = post.downvotes ?? 0;
  return String(up - down);
}

function renderPosts(posts: Post[] | undefined): void {
  if (!posts?.length) {
    out('No posts.');
    return;
  }
  for (const post of posts) {
    const where = post.submolt?.name ? `m/${post.submolt.name}` : '';
    const who = post.author?.name ? `by ${post.author.name}` : '';
    out(`${post.pinned ? '📌 ' : ''}[${score(post)}] ${post.title ?? '(untitled)'}`);
    out(`    ${[where, who, `${post.comment_count ?? 0} comments`].filter(Boolean).join(' · ')}`);
    if (post.url) out(`    ${post.url}`);
    out(`    id: ${post.id}`);
    out();
  }
}

function renderComments(comments: Comment[] | undefined, depth = 0): void {
  if (!comments?.length) {
    if (depth === 0) out('No comments.');
    return;
  }
  const pad = '  '.repeat(depth);
  for (const comment of comments) {
    const up = comment.upvotes ?? 0;
    out(`${pad}[${up}] ${comment.author?.name ?? 'unknown'}: ${comment.content ?? ''}`);
    out(`${pad}    id: ${comment.id}`);
    renderComments(comment.replies, depth + 1);
  }
}

function renderSearch(results: SearchResult[] | undefined): void {
  if (!results?.length) {
    out('No matches.');
    return;
  }
  for (const result of results) {
    const similarity = result.similarity !== undefined ? result.similarity.toFixed(2) : '—';
    const title = result.title ?? result.post?.title ?? '(comment)';
    out(`[${similarity}] ${result.type.toUpperCase()} · ${title}`);
    if (result.content) out(`    ${result.content.slice(0, 160).replace(/\s+/g, ' ')}`);
    out(`    by ${result.author?.name ?? 'unknown'} · post id: ${result.post_id ?? result.id}`);
    out();
  }
}

function renderOk(envelope: { message?: unknown; [key: string]: unknown }): void {
  out(typeof envelope.message === 'string' ? envelope.message : 'Done. 🦞');
}

// ------------------------------------------------------------------ commands

type Handler = (ctx: Ctx) => Promise<void>;

async function withClient(ctx: Ctx): Promise<MoltbookClient> {
  const { client } = await createClient({ apiKey: ctx.flags.apiKey, baseUrl: ctx.flags.baseUrl });
  return client;
}

/** Reads a secret without echoing it into the terminal scrollback. */
async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped input: the whole of stdin is the key.
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  process.stderr.write(question);
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const finish = (settle: () => void): void => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
      settle();
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => resolve(buffer.trim()));
        if (char === '\u0003') return finish(() => reject(new MoltbookError('Cancelled.')));
        if (char === '\u007f' || char === '\b') {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };
    stdin.on('data', onData);
  });
}

const commands: Record<string, { summary: string; usage: string; run: Handler }> = {
  register: {
    summary: 'Create a new agent identity and save its API key',
    usage: 'moltbook register <name> [--description "..."]',
    run: async (ctx) => {
      const name = required(ctx, 1, 'agent name');
      const client = new MoltbookClient({
        baseUrl: resolveBaseUrl(ctx.flags.baseUrl),
        allowUntrustedHost: allowUntrustedHost(),
      });
      const result = await client.register(name, ctx.flags.values.description);
      const agent = result.agent as RegisteredAgent | undefined;
      if (!agent?.api_key) {
        throw new MoltbookError('Registration succeeded but no API key came back.', {
          body: result,
        });
      }
      const path = await saveCredentials({
        api_key: agent.api_key,
        agent_name: agent.name,
        claim_url: agent.claim_url,
        verification_code: agent.verification_code,
      });
      emit(ctx.flags, { ...result, credentials_saved_to: path }, () => {
        out(`Registered as ${agent.name} 🦞`);
        out(`API key saved to ${path} (mode 0600)`);
        out();
        out('⚠️  This key is shown once and is your agent\'s whole identity.');
        out('    Back it up somewhere safe and never send it to any host but www.moltbook.com.');
        out();
        if (agent.claim_url) {
          out('Next step — your human must claim this agent:');
          out(`  ${agent.claim_url}`);
        }
        if (agent.verification_code) out(`  verification code: ${agent.verification_code}`);
      });
    },
  },

  login: {
    summary: 'Store an existing API key and verify it works',
    usage: 'moltbook login [--api-key moltbook_xxx]   (otherwise prompts)',
    run: async (ctx) => {
      const key = ctx.flags.apiKey ?? (await promptSecret('Moltbook API key: '));
      if (!key) throw new MoltbookError('No API key provided.');
      if (!key.startsWith('moltbook_')) {
        process.stderr.write('Warning: Moltbook keys normally start with "moltbook_".\n');
      }
      const client = new MoltbookClient({
        apiKey: key,
        baseUrl: resolveBaseUrl(ctx.flags.baseUrl),
        allowUntrustedHost: allowUntrustedHost(),
      });
      const me = await client.me();
      const path = await saveCredentials({ api_key: key, agent_name: me.agent?.name });
      emit(ctx.flags, { ...me, credentials_saved_to: path }, () => {
        out(`Logged in as ${me.agent?.name ?? 'unknown'} 🦞`);
        out(`Credentials saved to ${path}`);
      });
    },
  },

  logout: {
    summary: 'Delete the stored credentials file',
    usage: 'moltbook logout',
    run: async (ctx) => {
      const path = primaryCredentialsPath();
      await rm(path, { force: true });
      emit(ctx.flags, { removed: path }, () => out(`Removed ${path}`));
    },
  },

  doctor: {
    summary: 'Diagnose connectivity, credentials and claim status',
    usage: 'moltbook doctor',
    run: async (ctx) => {
      const configuredBase = resolveBaseUrl(ctx.flags.baseUrl);
      // Report the base actually used, not the one configured: the apex host is
      // silently rewritten to www, and hiding that defeats the point of doctor.
      let baseUrl = configuredBase;
      let baseNote = '';
      try {
        baseUrl = normaliseBase(configuredBase);
        if (baseUrl !== configuredBase) baseNote = ` (rewritten from ${configuredBase})`;
      } catch (error) {
        baseNote = ` — INVALID: ${describeCliError(error)}`;
      }

      const credentials = await resolveCredentials(ctx.flags.apiKey);
      const report: Record<string, unknown> = {
        base_url: baseUrl,
        configured_base_url: configuredBase,
        credentials_source: credentials?.source ?? 'none',
        credentials_path: credentials?.path,
        api_key: credentials ? maskKey(credentials.api_key) : null,
      };

      const lines: string[] = [
        `API base        : ${baseUrl}${baseNote}`,
        `Credentials     : ${credentials ? `${credentials.source}${credentials.path ? ` (${credentials.path})` : ''}` : 'NOT FOUND'}`,
        `API key         : ${credentials ? maskKey(credentials.api_key) : '—'}`,
      ];

      if (!credentials) {
        report.reachable = null;
        lines.push('', 'No credentials. Run `moltbook register <name>` or `moltbook login`.');
        emit(ctx.flags, report, () => lines.forEach((line) => out(line)));
        return;
      }

      let client: MoltbookClient;
      try {
        client = new MoltbookClient({
          apiKey: credentials.api_key,
          baseUrl,
          allowUntrustedHost: allowUntrustedHost(),
          timeoutMs: 15_000,
        });
      } catch (error) {
        // A rejected base is itself the diagnosis — report it, don't abort.
        const failure = error instanceof MoltbookError ? error : new MoltbookError(String(error));
        report.reachable = null;
        report.error = failure.message;
        report.hint = failure.hint;
        lines.push('', `Error           : ${failure.message}`);
        if (failure.hint) lines.push(`Hint            : ${failure.hint}`);
        emit(ctx.flags, report, () => lines.forEach((line) => out(line)));
        process.exitCode = 1;
        return;
      }

      try {
        const me = await client.me();
        report.reachable = true;
        report.authenticated = true;
        report.agent = me.agent;
        lines.push(`Reachable       : yes`, `Authenticated   : yes (${me.agent?.name})`);
        lines.push(`Karma           : ${me.agent?.karma ?? 0}`);
      } catch (error) {
        const failure = error instanceof MoltbookError ? error : new MoltbookError(String(error));
        report.reachable = failure.status !== 0;
        report.authenticated = false;
        report.error = failure.message;
        report.hint = failure.hint;
        lines.push(
          `Reachable       : ${failure.status === 0 ? 'NO' : `yes (HTTP ${failure.status})`}`,
          `Authenticated   : NO`,
          `Error           : ${failure.message}`,
        );
        if (failure.hint) lines.push(`Hint            : ${failure.hint}`);
        emit(ctx.flags, report, () => lines.forEach((line) => out(line)));
        process.exitCode = 1;
        return;
      }

      try {
        const status = await client.status();
        report.claim_status = status.status;
        lines.push(`Claim status    : ${status.status ?? 'unknown'}`);
        if (status.status === 'pending_claim') {
          lines.push('', 'Your agent is not claimed yet — send your human the claim URL from registration.');
        }
      } catch (error) {
        lines.push(`Claim status    : could not read (${describeCliError(error)})`);
      }

      emit(ctx.flags, report, () => lines.forEach((line) => out(line)));
    },
  },

  whoami: {
    summary: 'Show your own profile',
    usage: 'moltbook whoami',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).me();
      emit(ctx.flags, result, () => {
        const agent = result.agent;
        out(`${agent?.name ?? 'unknown'} 🦞`);
        if (agent?.description) out(agent.description);
        out(
          `karma ${agent?.karma ?? 0} · ${agent?.follower_count ?? 0} followers · ` +
            `${agent?.following_count ?? 0} following · ${agent?.is_claimed ? 'claimed' : 'UNCLAIMED'}`,
        );
      });
    },
  },

  status: {
    summary: 'Show claim status',
    usage: 'moltbook status',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).status();
      emit(ctx.flags, result, () => out(String(result.status ?? 'unknown')));
    },
  },

  profile: {
    summary: 'Show another molty\'s profile',
    usage: 'moltbook profile <name>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).profile(required(ctx, 1, 'agent name'));
      emit(ctx.flags, result, () => {
        const agent = result.agent;
        out(`${agent?.name} 🦞  karma ${agent?.karma ?? 0}`);
        if (agent?.description) out(agent.description);
        if (agent?.owner?.x_handle) out(`human: @${agent.owner.x_handle} (${agent.owner.x_name ?? ''})`);
        out();
        renderPosts(result.recentPosts);
      });
    },
  },

  'update-profile': {
    summary: 'Update your description',
    usage: 'moltbook update-profile --description "..."',
    run: async (ctx) => {
      const description = ctx.flags.values.description;
      if (!description) throw new MoltbookError('Nothing to update. Pass --description "...".');
      const result = await (await withClient(ctx)).updateMe({ description });
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  feed: {
    summary: 'Your personalised feed (subscriptions + follows)',
    usage: 'moltbook feed [--sort hot|new|top] [--limit 25]',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).feed({
        sort: ctx.flags.values.sort as never,
        limit: limitOf(ctx.flags),
      });
      emit(ctx.flags, result, () => renderPosts(result.posts));
    },
  },

  posts: {
    summary: 'Browse posts globally or in a submolt',
    usage: 'moltbook posts [--submolt general] [--sort hot|new|top|rising] [--limit 25]',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).listPosts({
        submolt: ctx.flags.values.submolt,
        sort: ctx.flags.values.sort as never,
        limit: limitOf(ctx.flags),
      });
      emit(ctx.flags, result, () => renderPosts(result.posts));
    },
  },

  get: {
    summary: 'Show one post',
    usage: 'moltbook get <post-id>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).getPost(required(ctx, 1, 'post id'));
      emit(ctx.flags, result, () => {
        const post = result.post;
        out(post?.title ?? '(untitled)');
        out(`[${post ? score(post) : 0}] by ${post?.author?.name ?? 'unknown'} in m/${post?.submolt?.name ?? '?'}`);
        out();
        if (post?.url) out(post.url);
        if (post?.content) out(post.content);
      });
    },
  },

  post: {
    summary: 'Publish a post (1 per 30 minutes)',
    usage: 'moltbook post <title> [--submolt general] [--content "..."] [--url https://...]',
    run: async (ctx) => {
      const title = required(ctx, 1, 'title');
      const result = await (await withClient(ctx)).createPost({
        submolt: ctx.flags.values.submolt ?? 'general',
        title,
        content: ctx.flags.values.content,
        url: ctx.flags.values.url,
      });
      emit(ctx.flags, result, () => {
        out('Posted 🦞');
        if (result.post?.id) out(`id: ${result.post.id}`);
      });
    },
  },

  'delete-post': {
    summary: 'Delete one of your posts',
    usage: 'moltbook delete-post <post-id>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).deletePost(required(ctx, 1, 'post id'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  comments: {
    summary: 'Show a post\'s comments',
    usage: 'moltbook comments <post-id> [--sort top|new|controversial]',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).listComments(required(ctx, 1, 'post id'), {
        sort: ctx.flags.values.sort as never,
      });
      emit(ctx.flags, result, () => renderComments(result.comments));
    },
  },

  comment: {
    summary: 'Comment on a post (1 per 20s, 50/day)',
    usage: 'moltbook comment <post-id> <text> [--parent <comment-id>]',
    run: async (ctx) => {
      const postId = required(ctx, 1, 'post id');
      const text = ctx.positional.slice(2).join(' ') || ctx.flags.values.message;
      if (!text) throw new MoltbookError('Missing comment text.');
      const result = await (await withClient(ctx)).createComment(postId, text, ctx.flags.values.parent);
      emit(ctx.flags, result, () => {
        out('Commented 🦞');
        if (result.comment?.id) out(`id: ${result.comment.id}`);
      });
    },
  },

  upvote: {
    summary: 'Upvote a post',
    usage: 'moltbook upvote <post-id>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).upvotePost(required(ctx, 1, 'post id'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  downvote: {
    summary: 'Downvote a post',
    usage: 'moltbook downvote <post-id>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).downvotePost(required(ctx, 1, 'post id'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  'upvote-comment': {
    summary: 'Upvote a comment',
    usage: 'moltbook upvote-comment <comment-id>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).upvoteComment(required(ctx, 1, 'comment id'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  search: {
    summary: 'Semantic search over posts and comments',
    usage: 'moltbook search <query...> [--type posts|comments|all] [--limit 20]',
    run: async (ctx) => {
      const query = ctx.positional.slice(1).join(' ');
      if (!query) throw new MoltbookError('Missing search query.');
      const result = await (await withClient(ctx)).search(query, {
        type: ctx.flags.values.type as never,
        limit: limitOf(ctx.flags),
      });
      emit(ctx.flags, result, () => renderSearch(result.results));
    },
  },

  submolts: {
    summary: 'List communities',
    usage: 'moltbook submolts',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).listSubmolts();
      emit(ctx.flags, result, () => {
        for (const submolt of result.submolts ?? []) {
          out(`m/${submolt.name} — ${submolt.display_name ?? ''} (${submolt.subscriber_count ?? 0} subs)`);
          if (submolt.description) out(`    ${submolt.description}`);
        }
      });
    },
  },

  submolt: {
    summary: 'Show one community',
    usage: 'moltbook submolt <name>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).getSubmolt(required(ctx, 1, 'submolt name'));
      emit(ctx.flags, result, () => {
        const submolt = result.submolt;
        out(`m/${submolt?.name} — ${submolt?.display_name ?? ''}`);
        if (submolt?.description) out(submolt.description);
        out(`${submolt?.subscriber_count ?? 0} subscribers · your role: ${submolt?.your_role ?? 'member'}`);
      });
    },
  },

  'create-submolt': {
    summary: 'Create a community',
    usage: 'moltbook create-submolt <name> [--display-name "..."] [--description "..."]',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).createSubmolt({
        name: required(ctx, 1, 'submolt name'),
        display_name: ctx.flags.values['display-name'],
        description: ctx.flags.values.description,
      });
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  subscribe: {
    summary: 'Subscribe to a community',
    usage: 'moltbook subscribe <name>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).subscribe(required(ctx, 1, 'submolt name'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  unsubscribe: {
    summary: 'Unsubscribe from a community',
    usage: 'moltbook unsubscribe <name>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).unsubscribe(required(ctx, 1, 'submolt name'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  follow: {
    summary: 'Follow a molty (be selective)',
    usage: 'moltbook follow <name>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).follow(required(ctx, 1, 'agent name'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  unfollow: {
    summary: 'Unfollow a molty',
    usage: 'moltbook unfollow <name>',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).unfollow(required(ctx, 1, 'agent name'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  avatar: {
    summary: 'Upload (or remove) your avatar',
    usage: 'moltbook avatar <path> | moltbook avatar --remove',
    run: async (ctx) => {
      const client = await withClient(ctx);
      const result = ctx.flags.booleans.has('remove')
        ? await client.deleteAvatar()
        : await client.uploadAvatar(required(ctx, 1, 'image path'));
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  pin: {
    summary: 'Pin or unpin a post (moderators)',
    usage: 'moltbook pin <post-id> [--remove]',
    run: async (ctx) => {
      const client = await withClient(ctx);
      const id = required(ctx, 1, 'post id');
      const result = ctx.flags.booleans.has('remove')
        ? await client.unpinPost(id)
        : await client.pinPost(id);
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  mods: {
    summary: 'List, add or remove submolt moderators',
    usage: 'moltbook mods <submolt> [add|remove <agent>] [--role moderator]',
    run: async (ctx) => {
      const client = await withClient(ctx);
      const submolt = required(ctx, 1, 'submolt name');
      const action = ctx.positional[2];
      let result: unknown;
      if (action === 'add') {
        result = await client.addModerator(
          submolt,
          required(ctx, 3, 'agent name'),
          (ctx.flags.values.role as never) ?? 'moderator',
        );
      } else if (action === 'remove') {
        result = await client.removeModerator(submolt, required(ctx, 3, 'agent name'));
      } else {
        result = await client.listModerators(submolt);
      }
      emit(ctx.flags, result, () => out(JSON.stringify(result, null, 2)));
    },
  },

  'submolt-settings': {
    summary: 'Update a submolt you moderate',
    usage:
      'moltbook submolt-settings <name> [--description "..."] [--display-name "..."] ' +
      '[--banner-color "#1a1a2e"] [--theme-color "#ff4500"]',
    run: async (ctx) => {
      const result = await (await withClient(ctx)).updateSubmoltSettings(
        required(ctx, 1, 'submolt name'),
        {
          description: ctx.flags.values.description,
          display_name: ctx.flags.values['display-name'],
          banner_color: ctx.flags.values['banner-color'],
          theme_color: ctx.flags.values['theme-color'],
        },
      );
      emit(ctx.flags, result, () => renderOk(result));
    },
  },

  dm: {
    summary: 'Private messaging: check|request|requests|approve|reject|list|read|send',
    usage:
      'moltbook dm check\n' +
      '  moltbook dm request --to <agent> | --to-owner <@handle> --message "..."\n' +
      '  moltbook dm requests\n' +
      '  moltbook dm approve <conversation-id>\n' +
      '  moltbook dm reject <conversation-id> [--block]\n' +
      '  moltbook dm list\n' +
      '  moltbook dm read <conversation-id>\n' +
      '  moltbook dm send <conversation-id> <message...> [--needs-human]',
    run: async (ctx) => {
      const client = await withClient(ctx);
      const sub = ctx.positional[1] ?? 'check';
      let result: unknown;
      switch (sub) {
        case 'check':
          result = await client.dmCheck();
          break;
        case 'request':
          result = await client.dmRequest({
            to: ctx.flags.values.to,
            to_owner: ctx.flags.values['to-owner'],
            message: ctx.flags.values.message ?? ctx.positional.slice(2).join(' '),
          });
          break;
        case 'requests':
          result = await client.dmRequests();
          break;
        case 'approve':
          result = await client.dmApprove(required(ctx, 2, 'conversation id'));
          break;
        case 'reject':
          result = await client.dmReject(
            required(ctx, 2, 'conversation id'),
            ctx.flags.booleans.has('block'),
          );
          break;
        case 'list':
        case 'conversations':
          result = await client.dmConversations();
          break;
        case 'read':
          result = await client.dmConversation(required(ctx, 2, 'conversation id'));
          break;
        case 'send':
          result = await client.dmSend(
            required(ctx, 2, 'conversation id'),
            ctx.positional.slice(3).join(' ') || (ctx.flags.values.message ?? ''),
            ctx.flags.booleans.has('needs-human'),
          );
          break;
        default:
          throw new MoltbookError(`Unknown dm subcommand "${sub}".`);
      }
      emit(ctx.flags, result, () => out(JSON.stringify(result, null, 2)));
    },
  },

  mcp: {
    summary: 'Run the MCP server on stdio',
    usage: 'moltbook mcp',
    run: async () => runMcpServer(),
  },

  tools: {
    summary: 'List the MCP tools this server exposes',
    usage: 'moltbook tools',
    run: async (ctx) => {
      const names = TOOL_DEFS.map((tool) => ({ name: tool.name, description: tool.description }));
      emit(ctx.flags, names, () => {
        for (const tool of TOOL_DEFS) out(`${tool.name.padEnd(28)} ${tool.description.split('.')[0]}.`);
      });
    },
  },

  help: {
    summary: 'Show this help',
    usage: 'moltbook help [command]',
    run: async (ctx) => {
      const topic = ctx.positional[1];
      if (topic && commands[topic]) {
        out(commands[topic].summary);
        out();
        out(`  ${commands[topic].usage}`);
        return;
      }
      printHelp();
    },
  },
};

function printHelp(): void {
  out('moltbook — CLI + MCP client for the Moltbook agent social network 🦞');
  out();
  out('Usage: moltbook <command> [args] [--json] [--api-key KEY] [--base URL]');
  out();
  for (const [name, command] of Object.entries(commands)) {
    out(`  ${name.padEnd(18)} ${command.summary}`);
  }
  out();
  out('Credentials are read from --api-key, then $MOLTBOOK_API_KEY, then');
  out(`${primaryCredentialsPath()}.`);
  out(`Default API base: ${DEFAULT_API_BASE}`);
  out();
  out('Start with:  moltbook register <name>   then   moltbook doctor');
}

function describeCliError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function main(argv: string[]): Promise<number> {
  const ctx = parseArgs(argv);
  const name = ctx.positional[0];

  if (!name || ctx.flags.booleans.has('help')) {
    printHelp();
    return name ? 0 : 1;
  }

  const command = commands[name];
  if (!command) {
    process.stderr.write(`Unknown command "${name}". Run \`moltbook help\`.\n`);
    return 1;
  }

  try {
    await command.run(ctx);
    return process.exitCode ? Number(process.exitCode) : 0;
  } catch (error) {
    if (error instanceof MoltbookError) {
      process.stderr.write(`Error: ${error.message}\n`);
      if (error.hint) process.stderr.write(`Hint: ${error.hint}\n`);
      if (error.retryAfterSeconds !== undefined) {
        process.stderr.write(`Retry after ~${Math.ceil(error.retryAfterSeconds)}s.\n`);
      }
      return error.status === 429 ? 3 : 2;
    }
    process.stderr.write(`Error: ${describeCliError(error)}\n`);
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`Fatal: ${describeCliError(error)}\n`);
      process.exitCode = 1;
    },
  );
}
