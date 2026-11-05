/**
 * dsh-collab — multi-agent collaboration for one working directory.
 *
 * The plugin is dormant until a hub is started in the current working
 * directory (by the human through `/collab on`, or by an agent with
 * `collab_hub {op:"enable"}` when the user asks for it). Once started, every
 * agent in that directory shares one Markdown memory bank, one task board, and
 * direct peer messaging, and receives a bounded hub summary as runtime context
 * before each model step.
 *
 * Extension points used:
 * - `ctx.tools.register` for the four `collab_*` tools.
 * - `ctx.systemPrompt.context` for the per-step shared-state summary.
 * - `ctx.commands.register` for the human `/collab` switch.
 * - `ctx.agents` to find live peers in the same directory.
 * @module dsh-collab
 */

import { watch } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';
import {
  HUB_DIR,
  LIMITS,
  TASK_STATUSES,
  addTask,
  appendEvent,
  appendMessage,
  countUnread,
  deleteMemory,
  disable,
  enable,
  join,
  listMemory,
  markInboxRead,
  pathsFor,
  readInbox,
  readMembers,
  readMemory,
  readPlan,
  readPresence,
  readState,
  removePresence,
  removeTask,
  searchMemory,
  shortId,
  updateTask,
  writeMemory,
  writePresence,
} from './hub.js';

/** Row id of this plugin; also its settings namespace. */
export const name = 'collab';

/** Services the plugin cannot run without. `workingDirectory` is optional and read through `ctx.get`. */
export const inject = ['tools', 'agents', 'systemPrompt', 'commands'];

/** Tunables. Everything is a plain value so the next tool call sees the current setting. */
export const Config = Schema.object({
  wakeIdlePeers: Schema.boolean()
    .default(true)
    .description('A message to an idle peer starts a new turn for it; false only queues the message.'),
  promptContext: Schema.boolean()
    .default(true)
    .description('Show a bounded hub summary (peers, plan, unread, memory) before each model step.'),
  refreshIntervalMs: Schema.number()
    .min(1000)
    .max(60000)
    .default(4000)
    .description('How often the cached hub summary is re-read from disk.'),
  maxPlanRows: Schema.number()
    .min(3)
    .max(100)
    .default(40)
    .description('Maximum plan rows one collab_plan list result returns.'),
  allowSessionRead: Schema.boolean()
    .default(true)
    .description('Allow collab_session to read other sessions working in this directory (their user/assistant text).'),
  watchHub: Schema.boolean()
    .default(true)
    .description('Watch .dsh-collab/ so peer activity from another window is picked up in well under a second.'),
});

/** The model-facing text block helper. */
const text = (value) => [{ type: 'text', text: value }];

/** One tool result: a rendered summary plus the structured payload kept in the log. */
const ok = (summary, data) => ({ summary, data });

const OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string', description: 'Rendered result the model reads.' },
    data: { type: 'json', description: 'Structured payload of the call.' },
  },
};

/** Render one value as a compact Markdown table. */
function table(rows, columns) {
  if (rows.length === 0) return '_none_';
  const header = `| ${columns.map((column) => column.title).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(row[column.key] ?? '')).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function countTasks(plan) {
  const counts = { total: plan.tasks.length, pending: 0, in_progress: 0, blocked: 0, completed: 0 };
  for (const task of plan.tasks) counts[task.status] = (counts[task.status] ?? 0) + 1;
  counts.open = counts.total - counts.completed;
  return counts;
}

/**
 * Register the hub, its tools, its prompt context and the human switch.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context
 * @param {any} config - validated plugin config
 */
export function apply(ctx, config) {
  const settings = () => ({
    wakeIdlePeers: config?.wakeIdlePeers !== false,
    promptContext: config?.promptContext !== false,
    refreshIntervalMs: Number(config?.refreshIntervalMs ?? 4000),
    maxPlanRows: Number(config?.maxPlanRows ?? 40),
    allowSessionRead: config?.allowSessionRead !== false,
    watchHub: config?.watchHub !== false,
  });

  /** This process's presence identity; a stale file from a dead process ages out. */
  const instanceId = `p${process.pid}-${randomUUID().slice(0, 8)}`;

  const service = (key) => {
    try {
      return ctx.get(key);
    } catch {
      return undefined;
    }
  };

  /** The agent's effective working directory, without creating anything. */
  function cwdOf(agent) {
    const workingDirectory = service('workingDirectory');
    if (workingDirectory !== undefined) {
      try {
        return workingDirectory.get(agent.session);
      } catch {
        // Fall through to the header value.
      }
    }
    return agent.session?.header?.cwd ?? process.cwd();
  }

  /** A display name derived from the session title, or a short stable id. */
  function titleOf(agent) {
    try {
      const title = service('sessionTitle')?.get(agent.session)?.title;
      if (typeof title === 'string' && title.trim().length > 0) return truncate(title.trim(), 48);
    } catch {
      // Titles are cosmetic; ignore failures.
    }
    return undefined;
  }

  /** Live agents whose effective directory is this hub root, excluding the caller. */
  function peersIn(root, selfId) {
    const peers = [];
    for (const agent of ctx.agents.list()) {
      if (agent.id === selfId) continue;
      let cwd;
      try {
        cwd = cwdOf(agent);
      } catch {
        continue;
      }
      if (samePath(cwd, root)) peers.push(agent);
    }
    return peers;
  }

  /**
   * A display name for one agent: the name it joined with, else the session
   * title for a human-owned session, else a short stable id. A subagent's title
   * is its task prompt, which reads as noise in a peer list, so subagents keep
   * the id form until they join explicitly.
   */
  function displayName(agent, members) {
    const joined = members?.[agent.id]?.name;
    if (typeof joined === 'string' && joined.length > 0) return joined;
    const header = agent.session?.header;
    const depth = header?.delegationDepth ?? agent.options?.subagentDepth ?? 0;
    const isSubagent = depth > 0 || header?.parentSession !== undefined || header?.origin === 'subagent';
    if (!isSubagent) {
      const title = titleOf(agent);
      if (title !== undefined) return title;
    }
    return `agent-${shortId(agent.id)}`;
  }

  /* ---------------------------------------------------------- hub cache -- */
  /**
   * Last known hub summary per directory, refreshed asynchronously. Runtime
   * context is rendered synchronously, so this cache is what the prompt sees.
   * @type {Map<string, {at: number, enabled: boolean, plan: any, members: any, memoryCount: number, unread: Record<string, number>}>}
   */
  const cache = new Map();

  async function refresh(root, options = {}) {
    const previous = cache.get(root);
    const now = Date.now();
    if (!options.force && previous !== undefined && now - previous.at < 750) return previous;
    const state = await readState(root);
    const next = {
      at: now,
      enabled: state.enabled,
      plan: previous?.plan ?? { version: 1, nextId: 1, tasks: [] },
      members: previous?.members ?? {},
      memoryCount: previous?.memoryCount ?? 0,
      unread: previous?.unread ?? {},
      remote: previous?.remote ?? [],
    };
    if (next.enabled) {
      const [plan, members, notes] = await Promise.all([
        readPlan(state.paths),
        readMembers(state.paths),
        listMemory(state.paths),
      ]);
      next.plan = plan;
      next.members = members.members;
      next.memoryCount = notes.length;
      const unread = {};
      for (const peer of ctx.agents.list()) {
        let cwd;
        try {
          cwd = cwdOf(peer);
        } catch {
          continue;
        }
        if (!samePath(cwd, root)) continue;
        unread[peer.id] = await countUnread(state.paths, peer.id);
      }
      next.unread = unread;
      ensureWatcher(root);
      const ttl = Math.max(20_000, settings().refreshIntervalMs * 5);
      const nowMs = Date.now();
      const remoteById = new Map();
      for (const record of await readPresence(state.paths).catch(() => [])) {
        if (record.instance === instanceId) continue;
        const seen = Date.parse(record.seenAt ?? '');
        if (!Number.isFinite(seen) || nowMs - seen > ttl) continue;
        for (const session of record.sessions ?? []) {
          if (typeof session?.id !== 'string' || remoteById.has(session.id)) continue;
          remoteById.set(session.id, {
            id: session.id,
            name: String(session.name ?? `agent-${shortId(session.id)}`),
            status: String(session.status ?? 'unknown'),
            instance: record.instance,
            pid: record.pid,
          });
        }
      }
      next.remote = [...remoteById.values()];
    }
    cache.set(root, next);
    return next;
  }

  /** Refresh without letting a failure reach the caller (the prompt never throws). */
  function refreshQuietly(root, options) {
    refresh(root, options).catch((error) => {
      ctx.logger?.debug?.(`dsh-collab: hub refresh failed for ${root}: ${error?.message ?? error}`);
    });
  }

  /* ---------------------------------------------------------- presence --- */

  /** Directory watchers for enabled hubs, keyed by root. */
  const watchers = new Map();
  /** Debounce timers for watch-driven refreshes, keyed by root. */
  const pendingRefreshes = new Map();
  const processStartedAt = new Date().toISOString();

  /** Last published heartbeat per root, so an unchanged peer set is not rewritten every tick. */
  const lastPresence = new Map();

  /** Publish this process's live sessions for one directory so other windows see them. */
  async function publishPresence(root, force = false) {
    const snapshot = cache.get(root);
    if (snapshot?.enabled !== true) return;
    const sessions = [];
    for (const agent of ctx.agents.list()) {
      let cwd;
      try {
        cwd = cwdOf(agent);
      } catch {
        continue;
      }
      if (!samePath(cwd, root)) continue;
      sessions.push({ id: agent.id, name: displayName(agent, snapshot.members), status: agent.status });
    }
    const key = sessions.map((session) => `${session.id}:${session.name}:${session.status}`).join(',');
    const previous = lastPresence.get(root);
    if (!force && previous?.key === key && Date.now() - previous.at < 12_000) return;
    try {
      await writePresence(pathsFor(root), {
        instance: instanceId,
        pid: process.pid,
        root,
        startedAt: processStartedAt,
        sessions,
      });
      lastPresence.set(root, { key, at: Date.now() });
    } catch (error) {
      ctx.logger?.debug?.(`dsh-collab: presence write failed for ${root}: ${error?.message ?? error}`);
    }
  }

  /** Coalesce a burst of filesystem events into one refresh. */
  function scheduleRefresh(root) {
    if (pendingRefreshes.has(root)) return;
    const timer = setTimeout(() => {
      pendingRefreshes.delete(root);
      refreshQuietly(root, { force: true });
    }, 200);
    timer.unref?.();
    pendingRefreshes.set(root, timer);
  }

  /** Watch one hub directory; a no-op when already watching or disabled. */
  function ensureWatcher(root) {
    if (!settings().watchHub || watchers.has(root)) return;
    try {
      const watcher = watch(pathsFor(root).dir, { recursive: true }, () => scheduleRefresh(root));
      watcher.on('error', () => {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
        watchers.delete(root);
      });
      watcher.unref?.();
      watchers.set(root, watcher);
    } catch (error) {
      ctx.logger?.debug?.(`dsh-collab: cannot watch ${root}: ${error?.message ?? error}`);
    }
  }

  /* ------------------------------------------------------ prompt context -- */

  function renderHubContext(agent, snapshot) {
    const root = cwdOf(agent);
    const name = displayName(agent, snapshot.members);
    const peers = peerRows(root, agent.id, snapshot).map(
      (peer) => `${peer.name} [${peer.status}${peer.remote ? ', other window' : ''}]`,
    );
    const counts = countTasks(snapshot.plan);
    const open = snapshot.plan.tasks.filter((task) => task.status !== 'completed');
    const active = open.filter((task) => task.status === 'in_progress').slice(0, 3);
    const pending = open.filter((task) => task.status === 'pending').slice(0, 3);
    const unread = snapshot.unread[agent.id] ?? 0;

    const lines = [
      `Collaboration hub (enabled): ${root} (${HUB_DIR})`,
      `You are "${name}". Peers in this directory: ${peers.length === 0 ? 'none yet' : peers.join(', ')}.`,
      `Shared plan: ${counts.open} open / ${counts.total} total` +
        (active.length === 0 ? '' : `; in progress: ${active.map((task) => `${task.id} ${JSON.stringify(truncate(task.title, 48))}${task.owner ? ` (${task.owner})` : ''}`).join(', ')}`) +
        (pending.length === 0 ? '' : `; next: ${pending.map((task) => `${task.id} ${JSON.stringify(truncate(task.title, 40))}`).join(', ')}`) +
        '.',
      unread === 0
        ? 'Unread peer messages: none.'
        : `Unread peer messages: ${unread} — read them with collab_message {op:"inbox"} before acting on shared files.`,
      `Shared memory: ${snapshot.memoryCount} notes — collab_plan / collab_memory are the shared source of truth; record decisions and constraints there.`,
    ];
    return lines.join('\n');
  }

  if (settings().promptContext) {
    const baseOrder = ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY');
    ctx.effect(() =>
      ctx.systemPrompt.context({
        name: 'collab:hub',
        order: Number.isFinite(baseOrder) ? baseOrder + 5 : 105,
        interpolate: false,
        text: (context) => {
          const agent = context?.agent;
          if (agent === undefined) return '';
          let root;
          try {
            root = cwdOf(agent);
          } catch {
            return '';
          }
          const snapshot = cache.get(root);
          if (snapshot === undefined) {
            refreshQuietly(root);
            return '';
          }
          if (!snapshot.enabled) return '';
          try {
            return renderHubContext(agent, snapshot);
          } catch {
            return '';
          }
        },
      }),
    );
  }

  /* ------------------------------------------------------------ helpers -- */

  function requireAgent(exec) {
    if (exec.agent === undefined) throw new Error('this tool requires a calling agent session');
    return exec.agent;
  }

  async function requireEnabled(agent) {
    const root = cwdOf(agent);
    const state = await readState(root);
    if (!state.enabled) {
      throw new Error(
        `the collaboration hub is not started in ${root}. Ask the user to run /collab on, or call collab_hub {op:"enable"} when the user asks for collaboration here`,
      );
    }
    return { root, paths: state.paths };
  }

  function planSummary(root, plan, limit) {
    const counts = countTasks(plan);
    const rows = plan.tasks
      .filter((task) => task.status !== 'completed')
      .slice(0, Math.max(1, Math.min(Number(limit ?? settings().maxPlanRows), 100)))
      .map((task) => ({
        id: task.id,
        status: task.status,
        owner: task.owner ?? '',
        title: truncate(task.title, 64),
      }));
    const head = `Plan for ${root}: ${counts.open} open / ${counts.total} total (${counts.in_progress} in progress, ${counts.blocked} blocked, ${counts.completed} completed).`;
    return `${head}\n\n${table(rows, [
      { key: 'id', title: 'id' },
      { key: 'status', title: 'status' },
      { key: 'owner', title: 'owner' },
      { key: 'title', title: 'title' },
    ])}`;
  }

  function peerRows(root, selfId, snapshot) {
    const members = snapshot?.members ?? {};
    const rows = peersIn(root, selfId).map((peer) => ({
      name: displayName(peer, members),
      id: peer.id,
      short: shortId(peer.id),
      status: peer.status,
      joined: members[peer.id] !== undefined,
      remote: false,
    }));
    const seen = new Set(rows.map((row) => row.id));
    for (const peer of snapshot?.remote ?? []) {
      if (peer.id === selfId || seen.has(peer.id)) continue;
      seen.add(peer.id);
      rows.push({
        name: peer.name,
        id: peer.id,
        short: shortId(peer.id),
        status: peer.status,
        joined: false,
        remote: true,
      });
    }
    return rows;
  }

  async function hubStatus(agent) {
    const root = cwdOf(agent);
    const snapshot = await refresh(root, { force: true });
    if (!snapshot.enabled) {
      return {
        summary:
          `The collaboration hub is NOT started in ${root}.\n` +
          `Start it with /collab on (human switch) or collab_hub {op:"enable"}.\n` +
          `When started, agents in this directory share ${HUB_DIR}/ memory, a task board and peer messages.`,
        data: { enabled: false, root, hubDir: pathsFor(root).dir },
      };
    }
    const peers = peerRows(root, agent.id, snapshot);
    const counts = countTasks(snapshot.plan);
    const unread = snapshot.unread[agent.id] ?? 0;
    const me = displayName(agent, snapshot.members);
    const remoteCount = peers.filter((peer) => peer.remote).length;
    const lines = [
      `Collaboration hub is ON for ${root}.`,
      `You are "${me}" (${agent.id}); peers: ${peers.length === 0 ? 'none live right now' : peers.map((peer) => `${peer.name} (${peer.status}${peer.remote ? ', other window' : ''}, ${peer.short})`).join(', ')}.`,
      `Plan: ${counts.open} open / ${counts.total} total. Memory: ${snapshot.memoryCount} notes. Unread messages: ${unread}.`,
      `This process: ${instanceId}, file watch ${watchers.has(root) ? 'on' : 'off'}, ${remoteCount} peer(s) from another process.`,
      '',
      planSummary(root, snapshot.plan),
    ];
    if (snapshot.memoryCount > 0) {
      const notes = await listMemory(pathsFor(root));
      lines.push('', 'Recent memory notes:', notes.slice(0, 10).map((note) => `- ${note.key} — ${truncate(note.title, 60)}${note.tags.length ? ` [${note.tags.join(', ')}]` : ''}`).join('\n'));
    }
    return {
      summary: lines.join('\n'),
      data: {
        enabled: true,
        root,
        me: { name: me, id: agent.id },
        peers,
        counts,
        unread,
        memoryCount: snapshot.memoryCount,
        instance: instanceId,
        watch: watchers.has(root),
      },
    };
  }

  /* ------------------------------------------------------- sessions ------ */

  /** The live-preferred session corpus; without it cross-session reads are unavailable. */
  function sessionQueryService() {
    const sessionQuery = service('sessionQuery');
    if (sessionQuery === undefined) {
      throw new Error('collab_session needs the sessionQuery service; this deployment does not compose it');
    }
    return sessionQuery;
  }

  /** Concatenate the text blocks of one message, ignoring images and tool blocks. */
  function messageText(message) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    return blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  /** Every session whose recorded working directory is this hub root, titles included. */
  async function sessionsIn(root) {
    const sessionQuery = sessionQueryService();
    const records = await sessionQuery.filterSessions([{ kind: 'cwd', values: [root] }]);
    const titles = new Map();
    try {
      const observed = await sessionQuery.readTitleSnapshots(records.map((record) => record.header.id));
      for (const item of observed) {
        if (item.status === 'fulfilled' && item.value?.title?.title) titles.set(item.sessionId, item.value.title.title);
      }
    } catch {
      // Titles are cosmetic; the list still works without them.
    }
    return records
      .map((record) => ({
        id: record.header.id,
        live: record.live === true,
        persisted: record.persisted === true,
        createdAt: record.header.createdAt,
        title: titles.get(record.header.id) ?? null,
        parent: record.header.parentSession ?? null,
        depth: record.header.delegationDepth ?? 0,
      }))
      .sort((left, right) => Number(right.live) - Number(left.live) || right.createdAt - left.createdAt);
  }

  /** Resolve a session by exact id, unique short id, or exact title. */
  function resolveSession(records, raw) {
    const want = String(raw ?? '').trim();
    if (want.length === 0) throw new Error('collab_session: read/search requires `id`; call op:"list" first');
    const lowered = want.toLowerCase();
    const exact = records.find((record) => record.id === want);
    if (exact !== undefined) return exact;
    const short = records.filter((record) => shortId(record.id).toLowerCase() === lowered);
    if (short.length === 1) return short[0];
    const byTitle = records.filter((record) => (record.title ?? '').toLowerCase() === lowered);
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) {
      throw new Error(`collab_session: title ${JSON.stringify(want)} matches ${byTitle.length} sessions; use a session id`);
    }
    throw new Error(`collab_session: no session ${JSON.stringify(want)} works in this directory (${records.length} known); call op:"list"`);
  }

  /* -------------------------------------------------------------- tools -- */

  const hubTool = defineTool({
    name: 'collab_hub',
    description:
      'Manage the shared collaboration hub for this working directory. `status` reports whether it is on, which peers are live, the shared plan, unread messages and memory size. `enable` starts it (creates .dsh-collab/), `disable` stops participation but keeps every file, `join` records your display name for peers. Only enable when the user asks to collaborate with other agents in this directory.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['status', 'enable', 'disable', 'join'],
        description: 'status (default entry point) | enable | disable | join',
      },
      name: { type: 'string', description: 'Display name for `join`; peers address you by it.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(value.summary) },
    timeoutMs: 20_000,
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const op = args.op ?? 'status';
      if (op === 'status') return hubStatus(agent);
      if (op === 'enable') {
        const root = cwdOf(agent);
        const requested = String(args.name ?? '').trim();
        const actor = requested || displayName(agent, (await refresh(root)).members);
        const { created } = await enable(root, actor);
        await join(pathsFor(root), agent.id, actor);
        await refresh(root, { force: true });
        await publishPresence(root, true);
        return ok(
          `${created ? 'Started' : 'Re-enabled'} the collaboration hub for ${root} (${HUB_DIR}).\n` +
            `Tools: collab_memory (shared notes), collab_plan (shared tasks), collab_message (peer messages).\n` +
            `Other agents in this directory will see the hub summary before their next step.`,
          { enabled: true, created, root },
        );
      }
      if (op === 'disable') {
        const root = cwdOf(agent);
        const member = (await readMembers(pathsFor(root))).members[agent.id];
        const { changed } = await disable(root, member?.name ?? titleOf(agent) ?? shortId(agent.id));
        await refresh(root, { force: true });
        return ok(
          `Collaboration hub disabled for ${root}. Files under ${HUB_DIR}/ are kept; /collab on resumes.`,
          { enabled: false, changed, root },
        );
      }
      if (op === 'join') {
        const root = cwdOf(agent);
        const { paths } = await requireEnabled(agent);
        const chosen = String(args.name ?? '').trim() || titleOf(agent) || `agent-${shortId(agent.id)}`;
        if (chosen.length > 48) throw new Error('collab_hub: name must be at most 48 characters');
        const member = await join(paths, agent.id, chosen);
        await refresh(root, { force: true });
        return ok(`Joined the hub as "${member.name}".`, { name: member.name, id: agent.id });
      }
      throw new Error(`collab_hub: unknown op ${JSON.stringify(op)}; use status, enable, disable or join`);
    },
    presentCall: (args) => ({ card: 'generic', title: `collab_hub · ${args.op ?? 'status'}`, kind: 'other' }),
  });

  const memoryTool = defineTool({
    name: 'collab_memory',
    description:
      'Read and write the collaboration hub\'s shared memory: `write` upserts one Markdown note by key, `read` returns one note, `search` ranks notes by title/tags/body, `list` enumerates notes, `delete` removes one. Use it for decisions, constraints, interfaces and findings that other agents in this directory must see before they act.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['write', 'read', 'search', 'list', 'delete'],
        description: 'write | read | search | list | delete',
      },
      key: { type: 'string', description: 'Stable lowercase slug, e.g. "auth-token-refresh". Required for write/read/delete.' },
      title: { type: 'string', description: 'Short human title (write).' },
      content: { type: 'string', description: `The note body (write). Keep one note under ${LIMITS.memoryEntryBytes} bytes.` },
      tags: { type: 'array', items: { type: 'string' }, description: 'Searchable tags (write).' },
      query: { type: 'string', description: 'Free text to rank notes against (search).' },
      limit: { type: 'integer', description: 'Maximum results (search/list), default 10.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(value.summary) },
    timeoutMs: 20_000,
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const { root, paths } = await requireEnabled(agent);
      const op = args.op;
      const limit = Math.max(1, Math.min(Number(args.limit ?? 10), 50));
      const author = displayName(agent, (await refresh(root)).members);
      if (op === 'write') {
        if (typeof args.key !== 'string' || args.key.trim() === '') throw new Error('collab_memory: write requires `key`');
        if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('collab_memory: write requires `content`');
        const entry = await writeMemory(paths, {
          key: args.key,
          title: args.title ?? args.key,
          content: args.content,
          tags: Array.isArray(args.tags) ? args.tags : [],
          author,
        });
        await appendEvent(paths, { type: 'memory/write', actor: author, key: entry.key });
        await refresh(root, { force: true });
        return ok(
          `Saved memory note "${entry.key}" (${entry.title}) — ${Buffer.byteLength(entry.content, 'utf8')} bytes${entry.previous ? ', replacing an earlier version' : ''}.`,
          { key: entry.key, title: entry.title, tags: entry.tags, updated: entry.updated },
        );
      }
      if (op === 'read') {
        if (typeof args.key !== 'string' || args.key.trim() === '') throw new Error('collab_memory: read requires `key`');
        const note = await readMemory(paths, args.key);
        return ok(
          `# ${note.title}\nkey: ${note.key} | tags: ${note.tags.join(', ') || '-'} | author: ${note.author || '-'} | updated: ${note.updated ?? '-'}\n\n${note.content}`,
          note,
        );
      }
      if (op === 'search') {
        const matches = await searchMemory(paths, args.query ?? '', limit);
        if (matches.length === 0) return ok(`No memory notes match ${JSON.stringify(args.query ?? '')}. Write one with collab_memory {op:"write"}.`, { matches: [] });
        const body = matches
          .map((match, index) => `${index + 1}. ${match.key} — ${match.title}${match.tags.length ? ` [${match.tags.join(', ')}]` : ''}\n   ${match.snippet}`)
          .join('\n');
        return ok(`${matches.length} matching note(s):\n\n${body}`, { matches });
      }
      if (op === 'list') {
        const notes = await listMemory(paths);
        if (notes.length === 0) return ok(`The memory bank for ${root} is empty.`, { notes: [] });
        const rows = notes.slice(0, limit).map((note) => ({
          key: note.key,
          title: truncate(note.title, 64),
          tags: note.tags.join(', '),
          updated: note.updated ?? '',
        }));
        return ok(
          `${notes.length} note(s) in ${paths.memory}:\n\n${table(rows, [
            { key: 'key', title: 'key' },
            { key: 'title', title: 'title' },
            { key: 'tags', title: 'tags' },
            { key: 'updated', title: 'updated' },
          ])}`,
          { notes: rows },
        );
      }
      if (op === 'delete') {
        if (typeof args.key !== 'string' || args.key.trim() === '') throw new Error('collab_memory: delete requires `key`');
        const removed = await deleteMemory(paths, args.key);
        await appendEvent(paths, { type: 'memory/delete', actor: author, key: removed.key });
        await refresh(root, { force: true });
        return ok(`Deleted memory note "${removed.key}".`, removed);
      }
      throw new Error(`collab_memory: unknown op ${JSON.stringify(op)}`);
    },
    presentCall: (args) => ({ card: 'generic', title: `collab_memory · ${args.op}`, kind: args.op === 'write' || args.op === 'delete' ? 'edit' : 'read' }),
  });

  const planTool = defineTool({
    name: 'collab_plan',
    description:
      'Maintain the hub\'s shared task board: `list`, `add` (title, optional detail/owner), `update` (status, owner, title, detail), `claim` (assign to you and mark in progress), `complete`, `delete`. Claim a task before editing the files it covers so two agents in this directory do not fight over the same edit.',
    parameters: {
      op: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'update', 'claim', 'complete', 'delete'],
        description: 'list | add | update | claim | complete | delete',
      },
      id: { type: 'string', description: 'Task id such as "t3" (update/claim/complete/delete).' },
      title: { type: 'string', description: 'Short imperative task title (add/update).' },
      detail: { type: 'string', description: 'What done looks like, interfaces, files (add/update).' },
      status: { type: 'string', enum: [...TASK_STATUSES], description: 'New status (update).' },
      owner: { type: 'string', description: 'Owner display name (add/update); empty string clears it.' },
      limit: { type: 'integer', description: 'Maximum rows for list, default 40.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(value.summary) },
    timeoutMs: 20_000,
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const { root, paths } = await requireEnabled(agent);
      const op = args.op;
      const author = displayName(agent, (await refresh(root)).members);
      if (op === 'list') {
        const plan = await readPlan(paths);
        return ok(planSummary(root, plan, args.limit), { tasks: plan.tasks });
      }
      if (op === 'add') {
        if (typeof args.title !== 'string' || args.title.trim() === '') throw new Error('collab_plan: add requires `title`');
        const task = await addTask(paths, {
          title: truncate(args.title.trim(), 160),
          detail: typeof args.detail === 'string' ? args.detail.trim() : '',
          owner: typeof args.owner === 'string' && args.owner.trim() !== '' ? args.owner.trim() : undefined,
          createdBy: author,
        });
        await appendEvent(paths, { type: 'plan/add', actor: author, id: task.id });
        await refresh(root, { force: true });
        return ok(`Added ${task.id}: ${task.title}${task.owner ? ` (owner ${task.owner})` : ''}.`, task);
      }
      if (op === 'update') {
        if (typeof args.id !== 'string' || args.id.trim() === '') throw new Error('collab_plan: update requires `id`');
        if (args.status !== undefined && !TASK_STATUSES.includes(args.status)) {
          throw new Error(`collab_plan: status must be one of ${TASK_STATUSES.join(', ')}`);
        }
        const patch = {};
        if (args.title !== undefined) patch.title = truncate(String(args.title).trim(), 160);
        if (args.detail !== undefined) patch.detail = String(args.detail);
        if (args.status !== undefined) patch.status = args.status;
        if (args.owner !== undefined) patch.owner = String(args.owner).trim() || null;
        if (Object.keys(patch).length === 0) throw new Error('collab_plan: update needs at least one of title, detail, status, owner');
        const task = await updateTask(paths, args.id, patch);
        await appendEvent(paths, { type: 'plan/update', actor: author, id: task.id, status: task.status });
        await refresh(root, { force: true });
        return ok(`${task.id} is now ${task.status}${task.owner ? ` (owner ${task.owner})` : ''}: ${task.title}`, task);
      }
      if (op === 'claim') {
        if (typeof args.id !== 'string' || args.id.trim() === '') throw new Error('collab_plan: claim requires `id`');
        const task = await updateTask(paths, args.id, { owner: args.owner?.trim?.() || author, status: 'in_progress' });
        await appendEvent(paths, { type: 'plan/claim', actor: author, id: task.id });
        await refresh(root, { force: true });
        return ok(`Claimed ${task.id} as ${task.owner}: ${task.title}`, task);
      }
      if (op === 'complete') {
        if (typeof args.id !== 'string' || args.id.trim() === '') throw new Error('collab_plan: complete requires `id`');
        const task = await updateTask(paths, args.id, { status: 'completed' });
        await appendEvent(paths, { type: 'plan/complete', actor: author, id: task.id });
        await refresh(root, { force: true });
        return ok(`Completed ${task.id}: ${task.title}`, task);
      }
      if (op === 'delete') {
        if (typeof args.id !== 'string' || args.id.trim() === '') throw new Error('collab_plan: delete requires `id`');
        const task = await removeTask(paths, args.id);
        await appendEvent(paths, { type: 'plan/delete', actor: author, id: task.id });
        await refresh(root, { force: true });
        return ok(`Deleted ${task.id}: ${task.title}`, task);
      }
      throw new Error(`collab_plan: unknown op ${JSON.stringify(op)}`);
    },
    presentCall: (args) => ({ card: 'generic', title: `collab_plan · ${args.op}`, kind: 'other' }),
  });

  const messageTool = defineTool({
    name: 'collab_message',
    description:
      'Exchange messages with another agent working in this directory: `send` writes the message to the peer\'s inbox and, by default, wakes it (a running peer reads it at its next step; an idle peer starts a new turn). `inbox` returns your unread messages and marks them read. Deliver results and changed constraints, not transcripts.',
    parameters: {
      op: { type: 'string', required: true, enum: ['send', 'inbox'], description: 'send | inbox' },
      to: { type: 'string', description: 'Peer display name, session id, or unique short-id prefix (send).' },
      body: { type: 'string', description: `Self-contained message text (send), at most ${LIMITS.messageBytes} bytes.` },
      wake: { type: 'boolean', description: 'Wake an idle peer to read it now; default follows the deployment config (true).' },
      limit: { type: 'integer', description: 'Maximum unread messages to return, default 20.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(value.summary) },
    timeoutMs: 20_000,
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const { root, paths } = await requireEnabled(agent);
      const snapshot = await refresh(root);
      const op = args.op;
      if (op === 'send') {
        const body = String(args.body ?? '').trim();
        if (body.length === 0) throw new Error('collab_message: send requires a non-empty `body`');
        if (Buffer.byteLength(body, 'utf8') > LIMITS.messageBytes) {
          throw new Error(`collab_message: body exceeds ${LIMITS.messageBytes} bytes; send a short summary`);
        }
        const target = resolveTarget(root, args.to, agent.id, snapshot.members, snapshot.remote);
        const fromName = displayName(agent, snapshot.members);
        const message = await appendMessage(paths, { fromId: agent.id, fromName, toId: target.id, body });
        await appendEvent(paths, { type: 'message', actor: fromName, to: target.name, id: message.id });

        const live = ctx.agents.get(target.id);
        const isRemotePeer = target.remote === true && live === undefined;
        let delivery = isRemotePeer ? 'stored-remote' : 'stored';
        if (live !== undefined) {
          try {
            const content = [
              { type: 'text', text: `Collaboration message from ${fromName} (${shortId(agent.id)}):` },
              { type: 'text', text: body },
            ];
            const input = createUserMessage({
              content,
              source: { kind: 'agent-message', form: 'relay', senderSessionId: agent.id },
            });
            const wake = args.wake ?? settings().wakeIdlePeers;
            if (wake && live.status === 'idle') {
              live.followup(input);
              delivery = 'woken';
            } else if (wake) {
              live.steer(input);
              delivery = 'steered';
            } else {
              live.inject(input);
              delivery = 'queued';
            }
          } catch (error) {
            ctx.logger?.warn?.(`dsh-collab: stored message for ${target.id} but could not deliver it: ${error?.message ?? error}`);
          }
        }
        await refresh(root, { force: true });
        return ok(
          `Sent to ${target.name} (${shortId(target.id)}) [delivery=${delivery}]: ${delivery === 'woken' ? 'delivered, peer woken' : delivery === 'steered' ? 'delivered into its current turn' : delivery === 'queued' ? 'queued without waking' : delivery === 'stored-remote' ? 'stored in its inbox; the peer runs in another window and will see it on its next step' : 'stored in its inbox (peer not live)'}.\nMessage: ${truncate(body, 200)}`,
          { id: message.id, to: { id: target.id, name: target.name }, delivery },
        );
      }
      if (op === 'inbox') {
        const limit = Math.max(1, Math.min(Number(args.limit ?? 20), LIMITS.inboxLimit));
        const inbox = await readInbox(paths, agent.id, limit);
        if (inbox.messages.length > 0) {
          await markInboxRead(paths, agent.id, inbox.messages[inbox.messages.length - 1].n);
          await refresh(root, { force: true });
        }
        if (inbox.messages.length === 0) return ok('No unread collaboration messages.', { messages: [], unread: 0 });
        const lines = inbox.messages.map(
          (message) => `#${message.n} from ${message.from} at ${message.time}:\n${truncate(message.body, 1200)}`,
        );
        return ok(`${inbox.unread} unread message(s); showing the latest ${inbox.messages.length}:\n\n${lines.join('\n\n')}`, {
          messages: inbox.messages,
          unread: inbox.unread,
        });
      }
      throw new Error(`collab_message: unknown op ${JSON.stringify(op)}`);
    },
    presentCall: (args) => ({ card: 'generic', title: `collab_message · ${args.op}`, kind: 'other' }),
  });

  const sessionTool = defineTool({
    name: 'collab_session',
    description:
      'Read other sessions working in this directory instead of asking the user to relay context: `list` shows every session recorded against this directory (live in this window or persisted on disk, with titles); `read` returns the latest user/assistant text of one session; `search` returns matching snippets from one session. Read-only, bounded, and limited to sessions whose working directory is this hub. Use it to pick up what another session decided, or to check whether a peer already did the work.',
    parameters: {
      op: { type: 'string', required: true, enum: ['list', 'read', 'search'], description: 'list | read | search' },
      id: { type: 'string', description: 'Session id, unique short id, or exact title (read/search).' },
      query: { type: 'string', description: 'Literal text to find (search).' },
      limit: { type: 'integer', description: 'Maximum rows: list default 30, read default 12 messages, search default 10 hits.' },
    },
    output: { schema: OUTPUT, render: (_args, value) => text(value.summary) },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const { root } = await requireEnabled(agent);
      if (!settings().allowSessionRead) {
        throw new Error('collab_session is disabled by the allowSessionRead config in this deployment');
      }
      const op = args.op;
      const rawLimit = Number(args.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 0;
      const records = await sessionsIn(root);
      if (op === 'list') {
        if (records.length === 0) return ok('No sessions are recorded for this directory yet.', { sessions: [] });
        const rows = records.slice(0, limit || 30).map((record) => ({
          id: shortId(record.id),
          state: record.live ? 'live' : record.persisted ? 'persisted' : 'unknown',
          mine: record.id === agent.id ? 'yes' : '',
          depth: record.depth,
          title: truncate(record.title ?? '(untitled)', 60),
        }));
        return ok(
          `${records.length} session(s) in ${root}:\n\n${table(rows, [
            { key: 'id', title: 'id' },
            { key: 'state', title: 'state' },
            { key: 'mine', title: 'you' },
            { key: 'depth', title: 'depth' },
            { key: 'title', title: 'title' },
          ])}`,
          { sessions: rows },
        );
      }
      const target = resolveSession(records, args.id);
      if (op === 'read') {
        const sessionQuery = sessionQueryService();
        const surface = await sessionQuery.readSurface(target.id);
        const events = surface.events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message');
        const picked = [];
        let bytes = 0;
        for (const event of events.slice(-(limit || 12))) {
          // A `user/message` surface event carries the message itself; an
          // `assistant/message` one wraps it with turn/step/stream fields.
          const message = event.type === 'user/message' ? event.data : event.data?.message;
          const body = messageText(message);
          if (body.length === 0) continue;
          const line = `${event.type === 'user/message' ? 'user' : 'assistant'}: ${truncate(body, 600)}`;
          if (bytes + line.length > 8000) break;
          bytes += line.length;
          picked.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text: line, time: event.time });
        }
        if (picked.length === 0) return ok(`Session ${shortId(target.id)} has no readable text messages yet.`, { messages: [] });
        const head =
          `Session ${shortId(target.id)} (${target.live ? 'live' : 'persisted'})` +
          `${target.title === null ? '' : ` "${truncate(target.title, 60)}"`} — latest ${picked.length} of ${events.length} messages:`;
        return ok(`${head}\n\n${picked.map((message) => message.text).join('\n\n')}`, {
          session: target.id,
          messages: picked,
        });
      }
      if (op === 'search') {
        const query = String(args.query ?? '').trim();
        if (query.length === 0) throw new Error('collab_session: search requires `query`');
        const sessionQuery = sessionQueryService();
        try {
          const page = await sessionQuery.searchEvents({ sessionId: target.id, query, limit: limit || 10 });
          if (page.items.length === 0) {
            return ok(`No matches for ${JSON.stringify(query)} in session ${shortId(target.id)}.`, { hits: [] });
          }
          const lines = page.items.map(
            (hit) => `seq ${hit.seq} ${hit.type} (${new Date(hit.time).toISOString()}): ${truncate(hit.snippet, 300)}`,
          );
          return ok(`${page.items.length} match(es) in session ${shortId(target.id)}:\n\n${lines.join('\n')}`, {
            hits: page.items,
          });
        } catch (error) {
          // The SQLite session index is optional; a deployment may disable it.
          // Fall back to scanning the session's current surface text so search
          // still answers, with a coarser snippet and no ranking.
          const surface = await sessionQuery.readSurface(target.id);
          const needle = query.toLowerCase();
          const hits = [];
          for (const event of surface.events) {
            if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
            const message = event.type === 'user/message' ? event.data : event.data?.message;
            const body = messageText(message);
            if (body.length === 0) continue;
            const at = body.toLowerCase().indexOf(needle);
            if (at < 0) continue;
            hits.push({
              seq: event.seq,
              type: event.type,
              time: event.time,
              snippet: body.slice(Math.max(0, at - 80), at + 200),
            });
            if (hits.length >= (limit || 10)) break;
          }
          if (hits.length === 0) {
            return ok(`No matches for ${JSON.stringify(query)} in session ${shortId(target.id)} (surface text scan).`, { hits: [] });
          }
          const lines = hits.map((hit) => `seq ${hit.seq} ${hit.type} (${new Date(hit.time).toISOString()}): ${truncate(hit.snippet, 300)}`);
          return ok(
            `${hits.length} match(es) in session ${shortId(target.id)} (surface text scan; the session index is unavailable: ${error?.message ?? error}):\n\n${lines.join('\n')}`,
            { hits },
          );
        }
      }
      throw new Error(`collab_session: unknown op ${JSON.stringify(op)}`);
    },
    presentCall: (args) => ({ card: 'generic', title: `collab_session · ${args.op}`, kind: 'read' }),
  });

  /**
   * Resolve a peer by display name, session id, or unique short-id prefix.
   * @param {string} root - hub directory
   * @param {unknown} target - the `to` argument
   * @param {string} selfId - caller id
   * @param {Record<string, {name: string}>} members - joined members
   */
  function resolveTarget(root, target, selfId, members, remote = []) {
    const raw = String(target ?? '').trim();
    if (raw.length === 0) throw new Error('collab_message: send requires `to` (peer name or session id)');
    const lowered = raw.toLowerCase();
    const live = peersIn(root, selfId);
    const candidates = [
      ...live.map((peer) => ({ agent: peer, id: peer.id, name: displayName(peer, members), remote: false })),
      ...remote
        .filter((peer) => peer.id !== selfId)
        .map((peer) => ({ agent: undefined, id: peer.id, name: peer.name, remote: true })),
    ];
    const exact = candidates.find((candidate) => candidate.id === raw);
    if (exact !== undefined) return exact;
    const short = candidates.filter((candidate) => shortId(candidate.id).toLowerCase() === lowered);
    if (short.length === 1) return short[0];
    const named = candidates.filter((candidate) => candidate.name.toLowerCase() === lowered);
    if (named.length === 1) return named[0];
    if (named.length > 1) {
      throw new Error(`collab_message: "${raw}" matches several peers (${named.map((candidate) => candidate.id).join(', ')}); use the session id`);
    }
    const known = Object.entries(members)
      .filter(([id, member]) => id !== selfId && String(member?.name ?? '').toLowerCase() === lowered)
      .map(([id, member]) => ({ id, name: member.name }));
    if (known.length === 1) return known[0];
    const available = candidates.length === 0 ? 'no live peers in this directory' : candidates.map((candidate) => `${candidate.name} (${shortId(candidate.id)})`).join(', ');
    throw new Error(`collab_message: no peer ${JSON.stringify(raw)}; available: ${available}`);
  }

  for (const tool of [hubTool, memoryTool, planTool, messageTool, sessionTool]) {
    ctx.effect(() => ctx.tools.register(tool));
  }

  /* ------------------------------------------------------------ command -- */

  async function commandStatus(agent) {
    const root = cwdOf(agent);
    const snapshot = await refresh(root, { force: true });
    if (!snapshot.enabled) {
      return [
        `Collaboration hub: OFF for ${root}`,
        `Start it for this working directory with /collab on`,
        `When on: shared memory + task board in ${HUB_DIR}/, peer discovery, and direct agent-to-agent messages.`,
      ].join('\n');
    }
    const peers = peerRows(root, agent.id, snapshot);
    const counts = countTasks(snapshot.plan);
    return [
      `Collaboration hub: ON for ${root}`,
      `Hub files: ${pathsFor(root).dir}`,
      `You: ${displayName(agent, snapshot.members)} (${shortId(agent.id)})`,
      `Peers live now: ${peers.length === 0 ? 'none' : peers.map((peer) => `${peer.name} [${peer.status}]`).join(', ')}`,
      `Plan: ${counts.open} open / ${counts.total} total — memory: ${snapshot.memoryCount} notes`,
      `Stop it for this directory with /collab off (files are kept).`,
    ].join('\n');
  }

  ctx.effect(() =>
    ctx.commands.register({
      name: 'collab',
      description: 'Start, stop or inspect the multi-agent collaboration hub for the current working directory.',
      input: { hint: '[status | on [name] | off | join <name>]' },
      async handler(invocation) {
        const agent = invocation.agent;
        const parts = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
        const action = (parts[0] ?? 'status').toLowerCase();
        const rest = parts.slice(1).join(' ').trim();
        const root = cwdOf(agent);
        try {
          if (action === 'on' || action === 'start' || action === 'enable') {
            const actor = rest || displayName(agent, (await refresh(root)).members);
            const { created } = await enable(root, actor);
            await join(pathsFor(root), agent.id, actor);
            const snapshot = await refresh(root, { force: true });
            await publishPresence(root, true);
            const peers = peerRows(root, agent.id, snapshot);
            return {
              kind: 'success',
              text: [
                `${created ? 'Started' : 'Re-enabled'} the collaboration hub for this working directory.`,
                `Hub: ${pathsFor(root).dir}`,
                `You joined as "${actor}". Peers live now: ${peers.length === 0 ? 'none yet — open another session in this directory to collaborate' : peers.map((peer) => peer.name).join(', ')}`,
                `Agents now share collab_memory (notes), collab_plan (tasks) and collab_message (messages), and see the hub summary before each step.`,
                `Stop it with /collab off.`,
              ].join('\n'),
            };
          }
          if (action === 'off' || action === 'stop' || action === 'disable') {
            const member = (await readMembers(pathsFor(root))).members[agent.id];
            const { changed } = await disable(root, member?.name ?? `agent-${shortId(agent.id)}`);
            await refresh(root, { force: true });
            return {
              kind: 'success',
              text: changed
                ? `Collaboration hub disabled for this working directory. Existing notes, plan and messages stay in ${HUB_DIR}/; /collab on resumes.`
                : `The collaboration hub was already off for this working directory.`,
            };
          }
          if (action === 'join' || action === 'name') {
            if (rest.length === 0) return { kind: 'error', text: 'Usage: /collab join <name>' };
            const { paths } = await requireEnabled(agent);
            const member = await join(paths, agent.id, rest.slice(0, 48));
            await refresh(root, { force: true });
            return { kind: 'success', text: `You joined the collaboration hub as "${member.name}".` };
          }
          if (action === 'status' || action === 'info') return { kind: 'success', text: await commandStatus(agent) };
          return { kind: 'error', text: `Unknown /collab action "${action}". Use status, on [name], off, or join <name>.` };
        } catch (error) {
          return { kind: 'error', text: `/collab failed: ${error?.message ?? error}` };
        }
      },
    }),
  );

  /* ------------------------------------------------------------ refresh -- */

  const timer = setInterval(() => {
    const roots = new Set();
    for (const agent of ctx.agents.list()) {
      try {
        roots.add(cwdOf(agent));
      } catch {
        // Skip agents whose directory cannot be read.
      }
    }
    for (const root of roots) {
      refresh(root, { force: true })
        .then((snapshot) => (snapshot.enabled ? publishPresence(root) : undefined))
        .catch(() => {});
    }
  }, Math.max(1000, settings().refreshIntervalMs));
  timer.unref?.();
  ctx.effect(() => () => clearInterval(timer));

  ctx.on('agent/created', ({ agent }) => {
    try {
      const root = cwdOf(agent);
      refresh(root, { force: true })
        .then((snapshot) => (snapshot.enabled ? publishPresence(root) : undefined))
        .catch(() => {});
    } catch {
      // A just-created agent may not expose a session yet.
    }
  });

  ctx.on('tools/result', (exec) => {
    if (exec?.agent === undefined) return;
    try {
      refreshQuietly(cwdOf(exec.agent));
    } catch {
      // Ignore.
    }
  });

  ctx.effect(() => () => {
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        // Already closed.
      }
    }
    watchers.clear();
    for (const pending of pendingRefreshes.values()) clearTimeout(pending);
    pendingRefreshes.clear();
    lastPresence.clear();
    for (const root of cache.keys()) void removePresence(pathsFor(root), instanceId);
    cache.clear();
  });

  ctx.logger?.info?.(`dsh-collab: ready (hub dir ${HUB_DIR} per working directory)`);
}
