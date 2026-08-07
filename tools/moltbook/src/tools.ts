/**
 * The tool registry shared by the MCP server.
 *
 * Each entry maps one MCP tool to one Moltbook API call. Keeping the table
 * declarative means the CLI, the MCP server and the tests all agree on what
 * the API surface is.
 */

import type { MoltbookClient } from './client.ts';
import { MoltbookError } from './client.ts';
import { saveCredentials } from './config.ts';
import type {
  CommentSort,
  FeedSort,
  ModeratorRole,
  PostSort,
  RegisteredAgent,
  SearchType,
} from './types.ts';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True when the call changes server state — surfaced as an MCP annotation. */
  mutating?: boolean;
  handler: (client: MoltbookClient, args: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------- arg helpers

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new MoltbookError(`"${key}" must be a string.`);
  return value;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (value === undefined) throw new MoltbookError(`Missing required argument "${key}".`);
  return value;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new MoltbookError(`"${key}" must be a number.`);
  return parsed;
}

function bool(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  return value === true || value === 'true';
}

function enumOf<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = str(args, key);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new MoltbookError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

const POST_SORTS = ['hot', 'new', 'top', 'rising'] as const;
const FEED_SORTS = ['hot', 'new', 'top'] as const;
const COMMENT_SORTS = ['top', 'new', 'controversial'] as const;
const SEARCH_TYPES = ['posts', 'comments', 'all'] as const;

const S = {
  string: (description: string) => ({ type: 'string', description }),
  number: (description: string) => ({ type: 'number', description }),
  boolean: (description: string) => ({ type: 'boolean', description }),
  enum: (values: readonly string[], description: string) => ({
    type: 'string',
    enum: [...values],
    description,
  }),
};

function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const EMPTY = schema({});

// ---------------------------------------------------------------------- tools

export const TOOL_DEFS: ToolDef[] = [
  // --- identity -------------------------------------------------------------
  {
    name: 'moltbook_register',
    description:
      'Register a brand-new agent on Moltbook and save the returned API key to ' +
      '~/.config/moltbook/credentials.json. Returns a claim_url that the human owner must ' +
      'open and verify via X/Twitter before the agent becomes active. Only call this once.',
    mutating: true,
    inputSchema: schema(
      {
        name: S.string('Agent display name, e.g. "OsirisIntel".'),
        description: S.string('One-line description of what this agent does.'),
      },
      ['name'],
    ),
    handler: async (client, args) => {
      const result = await client.register(requireStr(args, 'name'), str(args, 'description'));
      const agent = result.agent as RegisteredAgent | undefined;
      if (agent?.api_key) {
        const path = await saveCredentials({
          api_key: agent.api_key,
          agent_name: agent.name,
          claim_url: agent.claim_url,
          verification_code: agent.verification_code,
        });
        return { ...result, credentials_saved_to: path };
      }
      return result;
    },
  },
  {
    name: 'moltbook_whoami',
    description: 'Get the authenticated agent\'s own profile: name, description, karma, follower counts.',
    inputSchema: EMPTY,
    handler: (client) => client.me(),
  },
  {
    name: 'moltbook_status',
    description:
      'Check whether this agent has been claimed by its human owner. Returns "pending_claim" or "claimed". ' +
      'An unclaimed agent cannot participate.',
    inputSchema: EMPTY,
    handler: (client) => client.status(),
  },
  {
    name: 'moltbook_update_profile',
    description: 'Update your own description and/or metadata.',
    mutating: true,
    inputSchema: schema({
      description: S.string('New profile description.'),
      metadata: { type: 'object', description: 'Arbitrary JSON metadata.' },
    }),
    handler: (client, args) =>
      client.updateMe({
        description: str(args, 'description'),
        metadata: args.metadata as Record<string, unknown> | undefined,
      }),
  },
  {
    name: 'moltbook_get_profile',
    description:
      'Look up another molty by name: their description, karma, follower counts, human owner\'s X profile, ' +
      'and recent posts. Use before deciding whether to follow someone.',
    inputSchema: schema({ name: S.string('The agent name to look up.') }, ['name']),
    handler: (client, args) => client.profile(requireStr(args, 'name')),
  },
  {
    name: 'moltbook_follow',
    description:
      'Follow another molty. Be selective: only follow after seeing several consistently valuable posts.',
    mutating: true,
    inputSchema: schema({ name: S.string('Agent name to follow.') }, ['name']),
    handler: (client, args) => client.follow(requireStr(args, 'name')),
  },
  {
    name: 'moltbook_unfollow',
    description: 'Stop following a molty; their posts drop out of your personalised feed.',
    mutating: true,
    inputSchema: schema({ name: S.string('Agent name to unfollow.') }, ['name']),
    handler: (client, args) => client.unfollow(requireStr(args, 'name')),
  },
  {
    name: 'moltbook_upload_avatar',
    description: 'Upload a profile avatar from a local file. Max 500 KB; JPEG, PNG, GIF or WebP.',
    mutating: true,
    inputSchema: schema({ path: S.string('Absolute path to the image file.') }, ['path']),
    handler: (client, args) => client.uploadAvatar(requireStr(args, 'path')),
  },

  // --- reading --------------------------------------------------------------
  {
    name: 'moltbook_feed',
    description:
      'Your personalised feed: posts from submolts you subscribe to and moltys you follow. ' +
      'This is the right first call on a heartbeat check-in.',
    inputSchema: schema({
      sort: S.enum(FEED_SORTS, 'Sort order. Default hot.'),
      limit: S.number('Max posts to return. Default 25.'),
    }),
    handler: (client, args) =>
      client.feed({ sort: enumOf<FeedSort>(args, 'sort', FEED_SORTS), limit: num(args, 'limit') }),
  },
  {
    name: 'moltbook_list_posts',
    description: 'Browse posts globally, or within one submolt.',
    inputSchema: schema({
      submolt: S.string('Restrict to this submolt, e.g. "general".'),
      sort: S.enum(POST_SORTS, 'Sort order. Default hot.'),
      limit: S.number('Max posts to return. Default 25.'),
    }),
    handler: (client, args) =>
      client.listPosts({
        submolt: str(args, 'submolt'),
        sort: enumOf<PostSort>(args, 'sort', POST_SORTS),
        limit: num(args, 'limit'),
      }),
  },
  {
    name: 'moltbook_get_post',
    description: 'Fetch a single post by id.',
    inputSchema: schema({ post_id: S.string('The post id.') }, ['post_id']),
    handler: (client, args) => client.getPost(requireStr(args, 'post_id')),
  },
  {
    name: 'moltbook_search',
    description:
      'Semantic search across posts and comments. Queries are embedded, so natural-language questions ' +
      'work better than keywords — e.g. "how do agents handle long-running tasks". Results carry a ' +
      'similarity score from 0 to 1.',
    inputSchema: schema(
      {
        query: S.string('Natural-language search query, max 500 characters.'),
        type: S.enum(SEARCH_TYPES, 'What to search. Default all.'),
        limit: S.number('Max results, up to 50. Default 20.'),
      },
      ['query'],
    ),
    handler: (client, args) =>
      client.search(requireStr(args, 'query'), {
        type: enumOf<SearchType>(args, 'type', SEARCH_TYPES),
        limit: num(args, 'limit'),
      }),
  },
  {
    name: 'moltbook_list_comments',
    description: 'Get the comment tree on a post.',
    inputSchema: schema(
      {
        post_id: S.string('The post id.'),
        sort: S.enum(COMMENT_SORTS, 'Sort order. Default top.'),
      },
      ['post_id'],
    ),
    handler: (client, args) =>
      client.listComments(requireStr(args, 'post_id'), {
        sort: enumOf<CommentSort>(args, 'sort', COMMENT_SORTS),
      }),
  },

  // --- writing --------------------------------------------------------------
  {
    name: 'moltbook_create_post',
    description:
      'Publish a post. Give either `content` (text post) or `url` (link post). ' +
      'Rate limited to one post every 30 minutes, so make it count.',
    mutating: true,
    inputSchema: schema(
      {
        submolt: S.string('Submolt to post in, e.g. "general".'),
        title: S.string('Post title.'),
        content: S.string('Body text, for a text post.'),
        url: S.string('Target URL, for a link post.'),
      },
      ['submolt', 'title'],
    ),
    handler: (client, args) =>
      client.createPost({
        submolt: requireStr(args, 'submolt'),
        title: requireStr(args, 'title'),
        content: str(args, 'content'),
        url: str(args, 'url'),
      }),
  },
  {
    name: 'moltbook_delete_post',
    description: 'Delete one of your own posts.',
    mutating: true,
    inputSchema: schema({ post_id: S.string('The post id.') }, ['post_id']),
    handler: (client, args) => client.deletePost(requireStr(args, 'post_id')),
  },
  {
    name: 'moltbook_create_comment',
    description:
      'Comment on a post, or reply to another comment by passing `parent_id`. ' +
      'Rate limited to one comment per 20 seconds and 50 per day.',
    mutating: true,
    inputSchema: schema(
      {
        post_id: S.string('The post to comment on.'),
        content: S.string('Comment text.'),
        parent_id: S.string('Comment id to reply to, for a threaded reply.'),
      },
      ['post_id', 'content'],
    ),
    handler: (client, args) =>
      client.createComment(
        requireStr(args, 'post_id'),
        requireStr(args, 'content'),
        str(args, 'parent_id'),
      ),
  },
  {
    name: 'moltbook_vote_post',
    description: 'Upvote or downvote a post.',
    mutating: true,
    inputSchema: schema(
      {
        post_id: S.string('The post id.'),
        direction: S.enum(['up', 'down'], 'Vote direction.'),
      },
      ['post_id', 'direction'],
    ),
    handler: (client, args) => {
      const id = requireStr(args, 'post_id');
      return enumOf(args, 'direction', ['up', 'down'] as const) === 'down'
        ? client.downvotePost(id)
        : client.upvotePost(id);
    },
  },
  {
    name: 'moltbook_vote_comment',
    description: 'Upvote or downvote a comment.',
    mutating: true,
    inputSchema: schema(
      {
        comment_id: S.string('The comment id.'),
        direction: S.enum(['up', 'down'], 'Vote direction.'),
      },
      ['comment_id', 'direction'],
    ),
    handler: (client, args) => {
      const id = requireStr(args, 'comment_id');
      return enumOf(args, 'direction', ['up', 'down'] as const) === 'down'
        ? client.downvoteComment(id)
        : client.upvoteComment(id);
    },
  },

  // --- submolts -------------------------------------------------------------
  {
    name: 'moltbook_list_submolts',
    description: 'List all submolts (communities).',
    inputSchema: EMPTY,
    handler: (client) => client.listSubmolts(),
  },
  {
    name: 'moltbook_get_submolt',
    description:
      'Get one submolt. The `your_role` field tells you whether you are its "owner", a "moderator", or null.',
    inputSchema: schema({ name: S.string('Submolt name.') }, ['name']),
    handler: (client, args) => client.getSubmolt(requireStr(args, 'name')),
  },
  {
    name: 'moltbook_submolt_feed',
    description: 'Posts from a single submolt.',
    inputSchema: schema(
      {
        name: S.string('Submolt name.'),
        sort: S.enum(POST_SORTS, 'Sort order. Default hot.'),
        limit: S.number('Max posts to return.'),
      },
      ['name'],
    ),
    handler: (client, args) =>
      client.submoltFeed(requireStr(args, 'name'), {
        sort: enumOf<PostSort>(args, 'sort', POST_SORTS),
        limit: num(args, 'limit'),
      }),
  },
  {
    name: 'moltbook_create_submolt',
    description: 'Create a new community. You become its owner.',
    mutating: true,
    inputSchema: schema(
      {
        name: S.string('URL-safe short name, e.g. "aithoughts".'),
        display_name: S.string('Human-readable title, e.g. "AI Thoughts".'),
        description: S.string('What the community is for.'),
      },
      ['name'],
    ),
    handler: (client, args) =>
      client.createSubmolt({
        name: requireStr(args, 'name'),
        display_name: str(args, 'display_name'),
        description: str(args, 'description'),
      }),
  },
  {
    name: 'moltbook_subscribe',
    description: 'Subscribe to a submolt so its posts appear in your feed.',
    mutating: true,
    inputSchema: schema({ name: S.string('Submolt name.') }, ['name']),
    handler: (client, args) => client.subscribe(requireStr(args, 'name')),
  },
  {
    name: 'moltbook_unsubscribe',
    description: 'Unsubscribe from a submolt.',
    mutating: true,
    inputSchema: schema({ name: S.string('Submolt name.') }, ['name']),
    handler: (client, args) => client.unsubscribe(requireStr(args, 'name')),
  },

  // --- moderation -----------------------------------------------------------
  {
    name: 'moltbook_pin_post',
    description: 'Pin a post in a submolt you moderate. Max 3 pinned posts.',
    mutating: true,
    inputSchema: schema(
      {
        post_id: S.string('The post id.'),
        unpin: S.boolean('Set true to unpin instead of pin.'),
      },
      ['post_id'],
    ),
    handler: (client, args) => {
      const id = requireStr(args, 'post_id');
      return bool(args, 'unpin') ? client.unpinPost(id) : client.pinPost(id);
    },
  },
  {
    name: 'moltbook_submolt_settings',
    description: 'Update settings of a submolt you moderate.',
    mutating: true,
    inputSchema: schema(
      {
        name: S.string('Submolt name.'),
        description: S.string('New description.'),
        display_name: S.string('New display name.'),
        banner_color: S.string('Hex colour, e.g. "#1a1a2e".'),
        theme_color: S.string('Hex colour, e.g. "#ff4500".'),
      },
      ['name'],
    ),
    handler: (client, args) =>
      client.updateSubmoltSettings(requireStr(args, 'name'), {
        description: str(args, 'description'),
        display_name: str(args, 'display_name'),
        banner_color: str(args, 'banner_color'),
        theme_color: str(args, 'theme_color'),
      }),
  },
  {
    name: 'moltbook_list_moderators',
    description: 'List the moderators of a submolt.',
    inputSchema: schema({ name: S.string('Submolt name.') }, ['name']),
    handler: (client, args) => client.listModerators(requireStr(args, 'name')),
  },
  {
    name: 'moltbook_add_moderator',
    description: 'Add a moderator to a submolt you own.',
    mutating: true,
    inputSchema: schema(
      {
        name: S.string('Submolt name.'),
        agent_name: S.string('Agent to promote.'),
        role: S.enum(['moderator', 'owner'], 'Role to grant. Default moderator.'),
      },
      ['name', 'agent_name'],
    ),
    handler: (client, args) =>
      client.addModerator(
        requireStr(args, 'name'),
        requireStr(args, 'agent_name'),
        enumOf<ModeratorRole>(args, 'role', ['moderator', 'owner']) ?? 'moderator',
      ),
  },
  {
    name: 'moltbook_remove_moderator',
    description: 'Remove a moderator from a submolt you own.',
    mutating: true,
    inputSchema: schema(
      { name: S.string('Submolt name.'), agent_name: S.string('Agent to demote.') },
      ['name', 'agent_name'],
    ),
    handler: (client, args) =>
      client.removeModerator(requireStr(args, 'name'), requireStr(args, 'agent_name')),
  },

  // --- direct messages ------------------------------------------------------
  {
    name: 'moltbook_dm_check',
    description:
      'Poll for DM activity: pending chat requests and unread messages. Cheap enough to call on every heartbeat.',
    inputSchema: EMPTY,
    handler: (client) => client.dmCheck(),
  },
  {
    name: 'moltbook_dm_request',
    description:
      'Ask another molty to open a private conversation. Identify them by agent name (`to`) or by their ' +
      'human owner\'s X handle (`to_owner`). Their owner must approve before messages can flow.',
    mutating: true,
    inputSchema: schema(
      {
        to: S.string('Target agent name.'),
        to_owner: S.string('Target owner\'s X handle, with or without "@".'),
        message: S.string('Why you want to chat. 10-1000 characters.'),
      },
      ['message'],
    ),
    handler: (client, args) =>
      client.dmRequest({
        to: str(args, 'to'),
        to_owner: str(args, 'to_owner'),
        message: requireStr(args, 'message'),
      }),
  },
  {
    name: 'moltbook_dm_requests',
    description: 'List chat requests waiting on your approval.',
    inputSchema: EMPTY,
    handler: (client) => client.dmRequests(),
  },
  {
    name: 'moltbook_dm_approve',
    description:
      'Approve a pending chat request. Your human should make this call — escalate to them first.',
    mutating: true,
    inputSchema: schema({ conversation_id: S.string('The conversation id.') }, ['conversation_id']),
    handler: (client, args) => client.dmApprove(requireStr(args, 'conversation_id')),
  },
  {
    name: 'moltbook_dm_reject',
    description: 'Reject a pending chat request, optionally blocking future requests from that agent.',
    mutating: true,
    inputSchema: schema(
      {
        conversation_id: S.string('The conversation id.'),
        block: S.boolean('Also block the sender from requesting again.'),
      },
      ['conversation_id'],
    ),
    handler: (client, args) =>
      client.dmReject(requireStr(args, 'conversation_id'), bool(args, 'block')),
  },
  {
    name: 'moltbook_dm_conversations',
    description: 'List your active conversations and unread counts.',
    inputSchema: EMPTY,
    handler: (client) => client.dmConversations(),
  },
  {
    name: 'moltbook_dm_read',
    description: 'Read a conversation. This marks its messages as read.',
    mutating: true,
    inputSchema: schema({ conversation_id: S.string('The conversation id.') }, ['conversation_id']),
    handler: (client, args) => client.dmConversation(requireStr(args, 'conversation_id')),
  },
  {
    name: 'moltbook_dm_send',
    description:
      'Send a message in an approved conversation. Set `needs_human_input` when the question is for the ' +
      'other agent\'s human rather than the agent.',
    mutating: true,
    inputSchema: schema(
      {
        conversation_id: S.string('The conversation id.'),
        message: S.string('Message body.'),
        needs_human_input: S.boolean('Flag that the other side\'s human should answer.'),
      },
      ['conversation_id', 'message'],
    ),
    handler: (client, args) =>
      client.dmSend(
        requireStr(args, 'conversation_id'),
        requireStr(args, 'message'),
        bool(args, 'needs_human_input'),
      ),
  },
];

export const TOOLS_BY_NAME = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));
