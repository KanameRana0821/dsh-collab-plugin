/**
 * Shared collaboration hub storage for one working directory.
 *
 * Everything an agent needs to coordinate with another agent in the same
 * directory lives under `<cwd>/.dsh-collab/`:
 *
 * ```text
 * .dsh-collab/
 *   config.json              { version, enabled, createdAt, ... }
 *   members.json             display names of agents that joined
 *   plan.json                the shared task board
 *   memory/<key>.md          Markdown notes with YAML-ish frontmatter
 *   inbox/<session-id>.jsonl one message per line, appended in order
 *   inbox/<session-id>.state.json  { next, readThrough }
 *   events.jsonl             append-only audit trail
 * ```
 *
 * The hub is a plain directory on purpose: a human can read, diff and commit
 * the plan and the memory bank without any tooling. Writes are atomic
 * (temp file + rename) and read-modify-write cycles take a small lock file, so
 * two Harness processes sharing one directory cannot corrupt the board.
 * @module dsh-collab/hub
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Directory name created inside the working directory. */
export const HUB_DIR = '.dsh-collab';
/** On-disk format version of `config.json`. */
export const HUB_VERSION = 1;

/** Hard bounds that keep the shared bank small enough to stay model-friendly. */
export const LIMITS = Object.freeze({
  memoryEntryBytes: 32 * 1024,
  memoryFiles: 500,
  planTasks: 200,
  messageBytes: 8 * 1024,
  inboxLimit: 50,
});

/** Task lifecycle states, shared by the store and the tool schema. */
export const TASK_STATUSES = Object.freeze(['pending', 'in_progress', 'blocked', 'completed']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Absolute paths making up one hub.
 * @param {string} root - absolute working directory
 */
export function pathsFor(root) {
  const dir = path.join(root, HUB_DIR);
  return {
    root,
    dir,
    config: path.join(dir, 'config.json'),
    members: path.join(dir, 'members.json'),
    plan: path.join(dir, 'plan.json'),
    events: path.join(dir, 'events.jsonl'),
    memory: path.join(dir, 'memory'),
    inbox: path.join(dir, 'inbox'),
  };
}

/**
 * Stable short form of a session id for names and logs.
 * @param {string} id - session id
 */
export function shortId(id) {
  const stripped = id.startsWith('session-') ? id.slice('session-'.length) : id;
  return stripped.slice(0, 8);
}

/**
 * A filesystem-safe file stem for one session id.
 * @param {string} id - session id
 */
export function fileStem(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Read JSON, returning the fallback only when the file does not exist. */
async function readJson(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`collab: cannot read ${path.basename(file)}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`collab: ${path.basename(file)} is not valid JSON (${error.message}); fix or delete it`);
  }
}

/** Write a file atomically so a reader never sees a half-written document. */
async function writeFileAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

async function writeJson(file, value) {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Append one line to a JSONL file; O_APPEND keeps concurrent writers whole-line. */
async function appendLine(file, value) {
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

/**
 * Serialize one read-modify-write cycle.
 *
 * Cross-process safety uses an exclusive lock file with a stale-lock timeout;
 * in-process callers are already serialized by the awaited chain that holds
 * the lock. A lock that is never released (a crashed writer) expires instead
 * of wedging the hub.
 */
async function withLock(paths, run) {
  const lock = path.join(paths.dir, '.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.close();
      break;
    } catch (error) {
      // On Windows a concurrent remove of the lock file can surface as EPERM,
      // EACCES or EBUSY instead of EEXIST; all four mean "contended, retry".
      const contended = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!contended) throw error;
      try {
        const info = await fs.stat(lock);
        if (Date.now() - info.mtimeMs > 10_000) {
          await fs.rm(lock, { force: true }).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error('collab: the hub lock is held; retry shortly');
      await sleep(15 + Math.random() * 35);
    }
  }
  try {
    return await run();
  } finally {
    await fs.rm(lock, { force: true }).catch(() => {});
  }
}

/** Append one audit record; a failure here never fails the operation it describes. */
export async function appendEvent(paths, event) {
  try {
    await appendLine(paths.events, { time: new Date().toISOString(), ...event });
  } catch {
    // The audit trail is best-effort: the state change already happened.
  }
}

/**
 * Read the hub header without creating anything.
 * @param {string} root - working directory
 * @returns {Promise<{paths: ReturnType<typeof pathsFor>, config: any, enabled: boolean}>}
 */
export async function readState(root) {
  const paths = pathsFor(root);
  const config = await readJson(paths.config, null);
  return { paths, config, enabled: config?.enabled === true };
}

/**
 * Start (or restart) collaboration in one working directory.
 * @param {string} root - working directory
 * @param {string} actor - display name of the enabling agent
 * @returns {Promise<{created: boolean, config: object}>} whether the hub was created now
 */
export async function enable(root, actor) {
  const { paths, config } = await readState(root);
  if (config?.enabled === true) return { created: false, config };
  await fs.mkdir(paths.memory, { recursive: true });
  await fs.mkdir(paths.inbox, { recursive: true });
  const now = new Date().toISOString();
  const next = {
    version: HUB_VERSION,
    enabled: true,
    createdAt: config?.createdAt ?? now,
    enabledAt: now,
    enabledBy: actor ?? null,
    title: config?.title,
  };
  await writeJson(paths.config, next);
  await appendEvent(paths, { type: config === null ? 'created' : 'enabled', actor, cwd: root });
  return { created: config === null, config: next };
}

/**
 * Stop participating while keeping every file on disk.
 * @param {string} root - working directory
 * @param {string} actor - display name of the disabling agent
 */
export async function disable(root, actor) {
  const { paths, config } = await readState(root);
  if (config === null) return { changed: false, config: null };
  if (config.enabled === false) return { changed: false, config };
  const next = { ...config, enabled: false, disabledAt: new Date().toISOString(), disabledBy: actor ?? null };
  await writeJson(paths.config, next);
  await appendEvent(paths, { type: 'disabled', actor, cwd: root });
  return { changed: true, config: next };
}

/**
 * Record one agent's display name in the hub.
 * @param {object} paths - hub paths
 * @param {string} id - session id
 * @param {string} name - display name
 */
export async function join(paths, id, name) {
  return withLock(paths, async () => {
    const data = await readJson(paths.members, { version: 1, members: {} });
    const previous = data.members?.[id];
    const member = {
      name,
      joinedAt: previous?.joinedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    data.version = 1;
    data.members = { ...(data.members ?? {}), [id]: member };
    await writeJson(paths.members, data);
    await appendEvent(paths, { type: 'join', actor: name, sessionId: id });
    return member;
  });
}

/**
 * @param {object} paths - hub paths
 * @returns {Promise<{version: number, members: Record<string, {name: string, joinedAt: string}>}>}
 */
export async function readMembers(paths) {
  const data = await readJson(paths.members, { version: 1, members: {} });
  return { version: 1, members: data?.members ?? {} };
}

/* ------------------------------------------------------------------ plan -- */

function emptyPlan() {
  return { version: 1, nextId: 1, tasks: [], updatedAt: null };
}

/**
 * @param {object} paths - hub paths
 * @returns {Promise<{version: number, nextId: number, tasks: Array<any>}>}
 */
export async function readPlan(paths) {
  const plan = await readJson(paths.plan, null);
  if (plan === null) return emptyPlan();
  if (!Array.isArray(plan.tasks)) throw new Error('collab: plan.json has no tasks array; fix or delete it');
  return { version: 1, nextId: plan.nextId ?? plan.tasks.length + 1, tasks: plan.tasks };
}

/**
 * Mutate the plan under the hub lock.
 * @param {object} paths - hub paths
 * @param {(plan: any) => any} mutate - returns the value to resolve with
 */
async function mutatePlan(paths, mutate) {
  return withLock(paths, async () => {
    const plan = await readPlan(paths);
    const outcome = await mutate(plan);
    plan.updatedAt = new Date().toISOString();
    await writeJson(paths.plan, plan);
    return outcome;
  });
}

/**
 * Add one task to the shared board.
 * @param {object} paths - hub paths
 * @param {{title: string, detail?: string, owner?: string, createdBy: string}} input
 */
export async function addTask(paths, input) {
  return mutatePlan(paths, (plan) => {
    if (plan.tasks.length >= LIMITS.planTasks) {
      throw new Error(`collab: the plan already holds ${LIMITS.planTasks} tasks; complete or delete some first`);
    }
    const task = {
      id: `t${plan.nextId}`,
      title: input.title,
      detail: input.detail ?? '',
      status: 'pending',
      owner: input.owner ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };
    plan.nextId += 1;
    plan.tasks.push(task);
    return task;
  });
}

/**
 * Change one task; unspecified fields keep their value.
 * @param {object} paths - hub paths
 * @param {string} id - task id
 * @param {{title?: string, detail?: string, status?: string, owner?: string | null}} patch
 */
export async function updateTask(paths, id, patch) {
  return mutatePlan(paths, (plan) => {
    const task = plan.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) throw new Error(`collab: no task ${JSON.stringify(id)}; call collab_plan {op:"list"}`);
    for (const field of ['title', 'detail', 'status', 'owner']) {
      if (patch[field] !== undefined) task[field] = patch[field];
    }
    task.updatedAt = new Date().toISOString();
    return task;
  });
}

/**
 * Remove one task.
 * @param {object} paths - hub paths
 * @param {string} id - task id
 */
export async function removeTask(paths, id) {
  return mutatePlan(paths, (plan) => {
    const index = plan.tasks.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new Error(`collab: no task ${JSON.stringify(id)}; call collab_plan {op:"list"}`);
    const [removed] = plan.tasks.splice(index, 1);
    return removed;
  });
}

/* ---------------------------------------------------------------- memory -- */

/** Normalize a memory key into a safe lowercase slug. */
export function normalizeKey(raw) {
  const slug = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (slug.length === 0) throw new Error('collab: memory key must contain letters or digits');
  if (slug.length > 64) throw new Error('collab: memory key must be at most 64 characters');
  return slug;
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function parseMemory(text, fallbackKey) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) {
    return { key: fallbackKey, title: fallbackKey, tags: [], author: '', content: text.trim() };
  }
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const content = text.slice(match[0].length).replace(/^\s*\n/, '').trimEnd();
  return {
    key: meta.key || fallbackKey,
    title: meta.title || fallbackKey,
    tags: (meta.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
    author: meta.author ?? '',
    created: meta.created,
    updated: meta.updated,
    content,
  };
}

function serializeMemory(entry) {
  return [
    '---',
    `key: ${entry.key}`,
    `title: ${oneLine(entry.title)}`,
    `tags: ${entry.tags.join(', ')}`,
    `author: ${oneLine(entry.author)}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    '---',
    '',
    entry.content,
    '',
  ].join('\n');
}

/**
 * Create or replace one memory note.
 * @param {object} paths - hub paths
 * @param {{key: string, title?: string, content: string, tags?: string[], author: string}} input
 */
export async function writeMemory(paths, input) {
  const key = normalizeKey(input.key);
  const content = String(input.content ?? '').trim();
  if (content.length === 0) throw new Error('collab: memory content must not be empty');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > LIMITS.memoryEntryBytes) {
    throw new Error(`collab: memory content is ${bytes} bytes; keep one note under ${LIMITS.memoryEntryBytes}`);
  }
  const file = path.join(paths.memory, `${key}.md`);
  const previous = await readMemoryFile(file, key);
  const now = new Date().toISOString();
  const entry = {
    key,
    title: oneLine(input.title) || previous?.title || key,
    tags: [...new Set((input.tags ?? previous?.tags ?? []).map(oneLine).filter(Boolean))],
    author: input.author,
    created: previous?.created ?? now,
    updated: now,
    content,
  };
  const files = await fs.readdir(paths.memory).catch(() => []);
  if (previous === undefined && files.filter((name) => name.endsWith('.md')).length >= LIMITS.memoryFiles) {
    throw new Error(`collab: the memory bank already holds ${LIMITS.memoryFiles} notes; delete some first`);
  }
  await writeFileAtomic(file, serializeMemory(entry));
  return { ...entry, previous: previous === undefined ? null : previous.updated };
}

async function readMemoryFile(file, fallbackKey) {
  try {
    return parseMemory(await fs.readFile(file, 'utf8'), fallbackKey);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Read one note by key.
 * @param {object} paths - hub paths
 * @param {string} key - normalized or raw key
 */
export async function readMemory(paths, key) {
  const normalized = normalizeKey(key);
  const entry = await readMemoryFile(path.join(paths.memory, `${normalized}.md`), normalized);
  if (entry === undefined) throw new Error(`collab: no memory note ${JSON.stringify(normalized)}; search with collab_memory {op:"search"}`);
  return { ...entry, key: normalized };
}

/**
 * Every note, newest first.
 * @param {object} paths - hub paths
 * @param {{tag?: string}} [filter]
 */
export async function listMemory(paths, filter = {}) {
  const names = await fs.readdir(paths.memory).catch(() => []);
  const entries = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.md')).sort().slice(0, LIMITS.memoryFiles)) {
    const entry = await readMemoryFile(path.join(paths.memory, name), name.slice(0, -3));
    if (entry !== undefined) entries.push(entry);
  }
  entries.sort((left, right) => String(right.updated ?? '').localeCompare(String(left.updated ?? '')));
  const tag = filter.tag ? oneLine(filter.tag).toLowerCase() : '';
  return tag ? entries.filter((entry) => entry.tags.some((value) => value.toLowerCase() === tag)) : entries;
}

/**
 * Rank notes against a free-text query.
 *
 * Title hits weigh most, then tags, then body; the returned snippet marks the
 * matched region so the model can decide whether to read the whole note.
 * @param {object} paths - hub paths
 * @param {string} query - free text
 * @param {number} limit - maximum matches
 */
export async function searchMemory(paths, query, limit) {
  const needle = oneLine(query).toLowerCase();
  if (needle.length === 0) throw new Error('collab: search needs a non-empty query');
  const terms = needle.split(' ').filter(Boolean);
  const entries = await listMemory(paths);
  const scored = [];
  for (const entry of entries) {
    const title = entry.title.toLowerCase();
    const tags = entry.tags.join(' ').toLowerCase();
    const body = entry.content.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 6;
      if (tags.includes(term)) score += 3;
      if (body.includes(term)) score += 1;
    }
    if (score === 0) continue;
    const at = body.indexOf(terms[0]);
    const from = at < 0 ? 0 : Math.max(0, at - 80);
    const snippet = entry.content.slice(from, from + 240).replace(/\s+/g, ' ').trim();
    scored.push({ entry, score, snippet });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, Math.max(1, Math.min(limit, 20))).map(({ entry, snippet }) => ({
    key: entry.key,
    title: entry.title,
    tags: entry.tags,
    author: entry.author,
    updated: entry.updated,
    snippet,
  }));
}

/**
 * Delete one note.
 * @param {object} paths - hub paths
 * @param {string} key - note key
 */
export async function deleteMemory(paths, key) {
  const normalized = normalizeKey(key);
  const file = path.join(paths.memory, `${normalized}.md`);
  try {
    await fs.rm(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`collab: no memory note ${JSON.stringify(normalized)}`);
    throw error;
  }
  return { key: normalized };
}

/* ------------------------------------------------------------- presence -- */

/**
 * One file per Harness process inside `presence/`, so a session can see peers
 * that live in a different window (a different Host process) working in the
 * same directory. Presence is advisory: a stale heartbeat only hides a peer.
 * @param {object} paths - hub paths
 */
export function presenceDir(paths) {
  return path.join(paths.dir, 'presence');
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Publish this process's live sessions for one directory.
 * @param {object} paths - hub paths
 * @param {{instance: string, pid: number, root: string, sessions: Array<{id: string, name: string, status: string}>}} record
 */
export async function writePresence(paths, record) {
  const dir = presenceDir(paths);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, `${safeName(record.instance)}.json`), {
    version: 1,
    ...record,
    seenAt: new Date().toISOString(),
  });
}

/**
 * Read every published presence record, skipping corrupt or partial files.
 * @param {object} paths - hub paths
 */
export async function readPresence(paths) {
  const names = await fs.readdir(presenceDir(paths)).catch(() => []);
  const records = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = JSON.parse(await fs.readFile(path.join(presenceDir(paths), name), 'utf8'));
      if (typeof record?.instance === 'string' && Array.isArray(record.sessions)) records.push(record);
    } catch {
      // A torn or half-written heartbeat is skipped; the next one repairs it.
    }
  }
  return records;
}

/**
 * Remove this instance's presence file, so a clean unload leaves no ghost peer.
 * @param {object} paths - hub paths
 * @param {string} instance - presence identity
 */
export async function removePresence(paths, instance) {
  await fs.rm(path.join(presenceDir(paths), `${safeName(instance)}.json`), { force: true }).catch(() => {});
}

/* --------------------------------------------------------------- inbox --- */

function inboxPath(paths, id) {
  return path.join(paths.inbox, `${fileStem(id)}.jsonl`);
}

function inboxStatePath(paths, id) {
  return path.join(paths.inbox, `${fileStem(id)}.state.json`);
}

async function readInboxState(paths, id) {
  const state = await readJson(inboxStatePath(paths, id), null);
  return { next: state?.next ?? 1, readThrough: state?.readThrough ?? 0 };
}

async function readInboxLines(paths, id) {
  let text = '';
  try {
    text = await fs.readFile(inboxPath(paths, id), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const messages = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // A torn trailing line is ignored; the next successful append repairs nothing.
    }
  }
  return messages;
}

/**
 * Append one message to a peer's inbox and return it with its sequence number.
 * @param {object} paths - hub paths
 * @param {{fromId: string, fromName: string, toId: string, body: string}} input
 */
export async function appendMessage(paths, input) {
  return withLock(paths, async () => {
    const state = await readInboxState(paths, input.toId);
    const message = {
      n: state.next,
      id: randomUUID(),
      from: input.fromName,
      fromId: input.fromId,
      body: input.body,
      time: new Date().toISOString(),
    };
    await fs.mkdir(paths.inbox, { recursive: true });
    await appendLine(inboxPath(paths, input.toId), message);
    await writeJson(inboxStatePath(paths, input.toId), { next: state.next + 1, readThrough: state.readThrough });
    return message;
  });
}

/**
 * Unread messages for one session, oldest first, bounded.
 * @param {object} paths - hub paths
 * @param {string} id - recipient session id
 * @param {number} limit - maximum messages to return
 */
export async function readInbox(paths, id, limit) {
  const state = await readInboxState(paths, id);
  const all = await readInboxLines(paths, id);
  const unread = all.filter((message) => Number(message.n) > state.readThrough);
  return {
    unread: unread.length,
    total: all.length,
    readThrough: state.readThrough,
    messages: unread.slice(-Math.max(1, Math.min(limit, LIMITS.inboxLimit))),
  };
}

/**
 * Mark every message up to `through` as read.
 * @param {object} paths - hub paths
 * @param {string} id - recipient session id
 * @param {number} through - highest sequence number read
 */
export async function markInboxRead(paths, id, through) {
  if (!Number.isFinite(through) || through <= 0) return;
  return withLock(paths, async () => {
    const state = await readInboxState(paths, id);
    await writeJson(inboxStatePath(paths, id), {
      next: state.next,
      readThrough: Math.max(state.readThrough, Math.floor(through)),
    });
  });
}

/**
 * Count unread messages without loading the bodies into the caller.
 * @param {object} paths - hub paths
 * @param {string} id - recipient session id
 */
export async function countUnread(paths, id) {
  const state = await readInboxState(paths, id);
  const all = await readInboxLines(paths, id);
  return all.filter((message) => Number(message.n) > state.readThrough).length;
}
