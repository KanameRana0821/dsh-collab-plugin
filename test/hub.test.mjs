/**
 * Standalone checks for the hub storage layer: no Harness process required.
 *
 * Run with `node test/hub.test.mjs` (or `pnpm test`). The script uses a fresh
 * temporary directory, exercises every hub operation, and asserts the
 * concurrency guarantees the tools rely on.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as hub from '../hub.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-collab-test-'));
const paths = hub.pathsFor(root);

const initial = await hub.readState(root);
assert.equal(initial.enabled, false);
assert.equal(initial.config, null);

const enabled = await hub.enable(root, 'alice');
assert.equal(enabled.created, true);
assert.equal((await hub.readState(root)).enabled, true);

await hub.join(paths, 'session-aaa', 'alice');
assert.equal((await hub.readMembers(paths)).members['session-aaa'].name, 'alice');

const note = await hub.writeMemory(paths, {
  key: 'Auth Design',
  title: 'Auth design',
  content: 'Use refresh tokens. Access tokens live 15 minutes.',
  tags: ['auth', 'api'],
  author: 'alice',
});
assert.equal(note.key, 'auth-design');
assert.equal(note.previous, null);

const rewritten = await hub.writeMemory(paths, {
  key: 'auth-design',
  title: 'Auth design v2',
  content: 'Use refresh tokens. Access tokens live 10 minutes.',
  tags: ['auth'],
  author: 'bob',
});
assert.ok(rewritten.previous, 'a rewrite reports the replaced revision');

const read = await hub.readMemory(paths, 'AUTH-design');
assert.equal(read.title, 'Auth design v2');
assert.deepEqual(read.tags, ['auth']);
assert.match(read.content, /10 minutes/);

const matches = await hub.searchMemory(paths, 'refresh token', 5);
assert.equal(matches.length, 1);
assert.equal(matches[0].key, 'auth-design');

assert.equal((await hub.listMemory(paths)).length, 1);

const t1 = await hub.addTask(paths, { title: 'Wire login', detail: 'POST /login', createdBy: 'alice' });
assert.equal(t1.id, 't1');
const t2 = await hub.addTask(paths, { title: 'Write tests', createdBy: 'bob' });
assert.equal(t2.id, 't2');
assert.equal((await hub.updateTask(paths, t1.id, { owner: 'alice', status: 'in_progress' })).status, 'in_progress');
assert.equal((await hub.updateTask(paths, t2.id, { status: 'completed' })).status, 'completed');
assert.equal((await hub.readPlan(paths)).tasks.length, 2);
assert.equal((await hub.removeTask(paths, t2.id)).id, 't2');

const message = await hub.appendMessage(paths, {
  fromId: 'session-aaa',
  fromName: 'alice',
  toId: 'session-bbb',
  body: 'login endpoint is ready',
});
assert.equal(message.n, 1);
assert.equal((await hub.readInbox(paths, 'session-bbb', 20)).unread, 1);
await hub.markInboxRead(paths, 'session-bbb', 1);
assert.equal(await hub.countUnread(paths, 'session-bbb'), 0);

const second = await hub.appendMessage(paths, {
  fromId: 'session-aaa',
  fromName: 'alice',
  toId: 'session-bbb',
  body: 'tests failing on purpose',
});
assert.equal(second.n, 2);
await hub.markInboxRead(paths, 'session-bbb', 1);
assert.equal(await hub.countUnread(paths, 'session-bbb'), 1, 're-marking an older id keeps newer messages unread');
await hub.markInboxRead(paths, 'session-bbb', 2);
assert.equal(await hub.countUnread(paths, 'session-bbb'), 0);

await hub.deleteMemory(paths, 'auth-design');
assert.equal((await hub.listMemory(paths)).length, 0);

const disabled = await hub.disable(root, 'alice');
assert.equal(disabled.changed, true);
assert.equal((await hub.readState(root)).enabled, false);
assert.equal((await hub.enable(root, 'alice')).created, false, 're-enabling keeps the existing hub');

// Twenty concurrent plan writers must not lose a task.
const writes = await Promise.all(
  Array.from({ length: 20 }, (_, index) => hub.addTask(paths, { title: `task ${index}`, createdBy: 'carol' })),
);
assert.equal(new Set(writes.map((task) => task.id)).size, 20);
assert.equal((await hub.readPlan(paths)).tasks.length, 21, 'the earlier task survived disable/enable');

const events = (await fs.readFile(path.join(root, '.dsh-collab', 'events.jsonl'), 'utf8')).trim().split('\n');
assert.ok(events.length >= 4, `expected lifecycle audit events, got ${events.length}`);

await hub.writePresence(paths, {
  instance: 'p-test',
  pid: 1,
  root,
  startedAt: new Date().toISOString(),
  sessions: [{ id: 'session-x', name: 'remote-bob', status: 'idle' }],
});
const presence = await hub.readPresence(paths);
assert.equal(presence.length, 1);
assert.equal(presence[0].sessions[0].name, 'remote-bob');
await hub.writePresence(paths, {
  instance: 'p-test2',
  pid: 2,
  root,
  startedAt: new Date().toISOString(),
  sessions: [{ id: 'session-y', name: 'remote-carol', status: 'running' }],
});
assert.equal((await hub.readPresence(paths)).length, 2);
await hub.removePresence(paths, 'p-test');
assert.equal((await hub.readPresence(paths)).length, 1);
await hub.removePresence(paths, 'p-test2');
assert.equal((await hub.readPresence(paths)).length, 0);

await fs.rm(root, { recursive: true, force: true });
console.log('dsh-collab hub checks passed');
