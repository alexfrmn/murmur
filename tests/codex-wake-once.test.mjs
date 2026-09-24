import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteMessageStore } from '../packages/core/dist/src/index.js';
import { CodexAppServerClient, createCodexAppServerInjector } from '../scripts/codex-app-server-wake.mjs';
import { WakeMonitor } from '../scripts/wake-monitor.mjs';

async function until(check) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  assert.fail('wake-once test did not reach expected state');
}

function fixture(t, { unobservableTimeoutMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'murmur-once-'));
  const sessionPath = join(root, 'synthetic-rollout.jsonl');
  let store = new SQLiteMessageStore(join(root, 'murmur.db'));
  const starts = [], sockets = [], logs = [], relays = [], requests = [], turns = new Map();
  const observation = { mode: 'present' };
  class Socket extends EventEmitter {
    constructor() { super(); sockets.push(this); queueMicrotask(() => this.emit('open')); }
    emitMessage(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
    send(raw) {
      const req = JSON.parse(raw);
      requests.push(req);
      if (req.method === 'initialize') queueMicrotask(() => this.emitMessage({ id: req.id, result: {} }));
      if (req.method === 'thread/resume') queueMicrotask(() => this.emitMessage({ id: req.id, result: { thread: { id: 'thread-1', path: sessionPath } } }));
      if (req.method === 'turn/start') {
        this.turnId = `turn-${starts.length + 1}`;
        turns.set(this.turnId, { id: this.turnId, status: 'inProgress', items: [] });
        starts.push({ msgId: req.params.responsesapiClientMetadata.murmur_msg_id, socket: this });
        queueMicrotask(() => this.emitMessage({ id: req.id, result: { turn: { id: this.turnId } } }));
      }
      if (req.method === 'thread/read') queueMicrotask(() => this.emitMessage(observation.mode === 'unavailable'
        ? { id: req.id, error: { message: 'thread not found: thread-1' } }
        : { id: req.id, result: { thread: { id: 'thread-1', turns: observation.mode === 'missing' ? [] : [...turns.values()] } } }));
      if (req.method === 'thread/turns/list') queueMicrotask(() => this.emitMessage({ id: req.id, result: { data: [], nextCursor: null } }));
    }
    close() { this.closed = true; this.emit('close'); }
    complete(status = 'completed') {
      const item = { type: 'agentMessage', phase: 'final_answer', text: 'Synthetic answer' };
      const turn = { id: this.turnId, status, items: status === 'completed' ? [item] : [] };
      turns.set(this.turnId, turn);
      if (this.closed) return;
      if (status === 'completed') this.emitMessage({ method: 'item/completed', params: { threadId: 'thread-1', turnId: this.turnId, item } });
      this.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn } });
    }
  }
  class Client extends CodexAppServerClient {
    constructor(options) { super({ ...options, WebSocketImpl: Socket }); }
    startTurnAndWaitForFinal(params, options) {
      return super.startTurnAndWaitForFinal(params, { ...options, pollIntervalMs: 10, maxPollIntervalMs: 20 });
    }
  }
  const makeInjector = () => createCodexAppServerInjector({ Client, threadStore: store, log: (...args) => logs.push(args),
    relayAlreadyQueued: async () => false, relay: async (_peer, payload) => { relays.push(payload.msgId); return { msgId: `reply-${payload.msgId}` }; } });
  const monitor = new WakeMonitor({ deliveries: store, injector: makeInjector(), retryBackoffMs: 1,
    peers: { colleague: { mode: 'codex_app_server', socketPath: '/unused-test.sock', threadId: 'thread-1', relayFinalToMurmur: true, replyTimeoutMs: 30, unobservableTimeoutMs } } });
  const receive = async (msgId, from = 'colleague') => {
    const row = await store.append({ msgId, conversationId: 'test', direction: 'inbound', sender: from,
      text: 'Synthetic question', createdAt: new Date().toISOString(), transport: 'nats', wakeEligible: true });
    return { msgId, conversationId: row.conversationId, from: row.sender, text: row.text, cursor: row.rowid, wakeEligible: true };
  };
  t.after(async () => {
    monitor.enabled = false;
    observation.mode = 'present';
    for (const turn of turns.values()) turn.status = 'completed';
    for (const socket of sockets) if (socket.turnId) socket.complete();
    await until(() => !monitor.processing);
    store.close(); rmSync(root, { recursive: true, force: true });
  });
  return { get store() { return store; }, monitor, receive, starts, logs, relays, turns, requests, sessionPath, observation,
    restart() {
      store.close(); store = new SQLiteMessageStore(join(root, 'murmur.db'));
      monitor.deliveries = store; monitor.injector = makeInjector();
    } };
}

test('accepted turn longer than replyTimeout keeps one turn/start and queues the next letter', async t => {
  const f = fixture(t), first = await f.receive('first');
  const run = f.monitor.onInbound(first);
  await until(() => f.starts.length === 1);
  await delay(100); // several completion windows; the Assistant is still working
  await f.monitor.drain();
  assert.equal(f.starts.length, 1, 'timeout must never start the accepted letter again');
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight');
  assert.equal((await f.store.wakeStateFor('first')).attempts, 1);
  assert.equal((await f.store.getWakeTurn('first')).turnId, 'turn-1');
  assert.ok(f.logs.some(([, , event]) => event?.reason === 'completion-window-elapsed'));
  await f.monitor.onInbound({ ...first });
  await f.monitor.onInbound(await f.receive('second'));
  await delay(50);
  assert.equal(f.starts.length, 1);
  assert.equal((await f.store.wakeStateFor('second')).status, 'pending');
  assert.deepEqual(f.relays, []);
  f.starts[0].socket.complete();
  await until(() => f.starts.length === 2);
  assert.deepEqual(f.starts.map(s => s.msgId), ['first', 'second']);
  f.starts[1].socket.complete(); await run;
  assert.deepEqual(f.relays, ['first', 'second']);
  assert.equal((await f.store.wakeStateFor('first')).status, 'handled');
  assert.equal((await f.store.wakeStateFor('second')).status, 'handled');
});

for (const mode of ['missing', 'unavailable']) test(`an accepted turn with ${mode} observation reaches a non-retryable DLQ`, async t => {
  const f = fixture(t, { unobservableTimeoutMs: 80 });
  const run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  f.observation.mode = mode;
  await until(async () => (await f.store.wakeStateFor('first')).status === 'dlq');
  const state = await f.store.wakeStateFor('first');
  assert.equal(state.status, 'dlq'); assert.equal(state.error, 'accepted-turn-unobservable');
  await run; assert.equal(f.monitor.processing, false);
  f.restart(); await f.monitor.drain();
  assert.equal(f.starts.length, 1); assert.deepEqual(f.relays, []);
  assert.equal((await f.store.getWakeTurn('first')).turnId, 'turn-1');
});

test('the unobservable deadline survives process restart instead of starting a new window', async t => {
  const f = fixture(t, { unobservableTimeoutMs: 10000 }), first = await f.receive('first');
  await f.store.claimWake(first.msgId);
  await f.store.setWakeTurn({ msgId: first.msgId, peerId: first.from, conversationId: first.conversationId,
    socketPath: '/unused-test.sock', threadId: 'thread-1', turnId: 'previous-turn',
    unobservableSince: new Date(Date.now() - 10001).toISOString() });
  f.turns.set('previous-turn', { id: 'previous-turn', status: 'inProgress', items: [] });
  f.observation.mode = 'missing'; f.restart();
  const run = f.monitor.drain();
  await until(async () => (await f.store.wakeStateFor('first')).status === 'dlq');
  assert.equal((await f.store.wakeStateFor('first')).status, 'dlq');
  await run; assert.equal(f.starts.length, 0);
});

test('observed in-progress work clears a temporary loss of observation', async t => {
  const f = fixture(t, { unobservableTimeoutMs: 150 });
  const run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  f.observation.mode = 'missing';
  await until(async () => (await f.store.wakeStateFor('first')).error === 'accepted-turn-unobservable');
  f.observation.mode = 'present';
  await until(async () => !(await f.store.wakeStateFor('first')).error);
  await delay(200);
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight');
  assert.equal(f.starts.length, 1);
  f.starts[0].socket.complete(); await run;
});

for (const relay of [true, false]) test(`task_complete with error is failed and retryable (relay=${relay})`, async t => {
  const f = fixture(t), first = await f.receive('first');
  f.monitor.retryBackoffMs = 10000;
  f.monitor.peers.colleague.relayFinalToMurmur = relay;
  await f.store.claimWake(first.msgId);
  await f.store.setWakeTurn({ msgId: first.msgId, peerId: first.from, conversationId: first.conversationId,
    socketPath: '/unused-test.sock', threadId: 'thread-1', turnId: 'previous-turn', sessionPath: f.sessionPath });
  writeFileSync(f.sessionPath, JSON.stringify({ type: 'event_msg', payload: {
    type: 'task_complete', turn_id: 'previous-turn', last_agent_message: 'Partial answer', error: { message: 'model overloaded' },
  } }) + '\n');
  f.turns.set('previous-turn', { id: 'previous-turn', status: 'failed', items: [] });
  f.restart(); await f.monitor.drain();
  const state = await f.store.wakeStateFor('first');
  assert.equal(state.status, 'failed'); assert.match(state.error, /^codex-app-server-turn-failed:/);
  assert.deepEqual(f.relays, []); assert.equal(f.starts.length, 0);
  assert.equal(await f.store.getWakeTurn('first'), undefined);
});

test('connection loss after acceptance observes the same turn without retrying its instruction', async t => {
  const f = fixture(t), run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  const socket = f.starts[0].socket;
  socket.close(); await delay(100);
  await f.monitor.drain();
  assert.equal(f.starts.length, 1);
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight');
  socket.complete(); await run;
  assert.ok(f.requests.some(r => r.method === 'thread/read'));
  assert.equal(f.starts.length, 1); assert.deepEqual(f.relays, ['first']);
});

test('a new process recovers the persisted accepted turn before starting queued work', async t => {
  const f = fixture(t), first = await f.receive('first');
  await f.store.claimWake(first.msgId);
  await f.store.setWakeTurn({ msgId: first.msgId, peerId: first.from, conversationId: first.conversationId,
    socketPath: '/unused-test.sock', threadId: 'thread-1', turnId: 'previous-turn' });
  f.turns.set('previous-turn', { id: 'previous-turn', status: 'inProgress', items: [] });
  f.restart();
  const run = f.monitor.drain();
  await until(() => f.requests.some(r => r.method === 'thread/read'));
  await delay(100);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight');
  f.turns.set('previous-turn', { id: 'previous-turn', status: 'completed',
    items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Synthetic recovered answer' }] });
  await run;
  assert.equal(f.starts.length, 0); assert.deepEqual(f.relays, ['first']);
  assert.equal((await f.store.wakeStateFor('first')).status, 'handled');
});

test('disabling reply relay does not discard an accepted turn on restart', async t => {
  const f = fixture(t), first = await f.receive('first');
  await f.store.claimWake(first.msgId);
  await f.store.setWakeTurn({ msgId: first.msgId, peerId: first.from, conversationId: first.conversationId,
    socketPath: '/unused-test.sock', threadId: 'thread-1', turnId: 'previous-turn' });
  f.turns.set('previous-turn', { id: 'previous-turn', status: 'inProgress', items: [] });
  f.restart(); f.monitor.peers.colleague.relayFinalToMurmur = false;
  const run = f.monitor.drain();
  await until(() => f.requests.some(r => r.method === 'thread/read' || r.method === 'turn/start'));
  assert.equal(f.starts.length, 0, 'the saved acceptance still owns this instruction');
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight');
  f.turns.set('previous-turn', { id: 'previous-turn', status: 'completed', items: [] });
  await run;
  assert.equal((await f.store.wakeStateFor('first')).status, 'handled');
  assert.deepEqual(f.relays, []); assert.equal(f.starts.length, 0);
});

for (const status of ['failed', 'interrupted']) test(`a verified ${status} turn keeps its existing retry policy`, async t => {
  const f = fixture(t);
  f.monitor.retryBackoffMs = 10000;
  const run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  f.starts[0].socket.complete(status); await run;
  assert.deepEqual(f.relays, []);
  assert.equal((await f.store.wakeStateFor('first')).status, status === 'failed' ? 'failed' : 'dlq');
  if (status === 'failed') {
    assert.equal(await f.store.getWakeTurn('first'), undefined);
    f.monitor.now = () => Date.now() + 10001;
    const retry = f.monitor.drain();
    await until(() => f.starts.length === 2);
    f.starts[1].socket.complete(); await retry;
    assert.equal((await f.store.wakeStateFor('first')).status, 'handled');
  } else {
    await f.monitor.drain(); assert.equal(f.starts.length, 1);
    assert.equal((await f.store.getWakeTurn('first')).turnId, 'turn-1');
  }
});

test('unrelated completion events cannot release the active letter or its lane', async t => {
  const f = fixture(t), run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  const socket = f.starts[0].socket;
  for (const [threadId, turnId] of [['another-thread', socket.turnId], ['thread-1', 'another-turn']]) {
    socket.emitMessage({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
  }
  socket.emitMessage({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: socket.turnId, status: 'inProgress' } } });
  await delay(100);
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight'); assert.deepEqual(f.relays, []);
  socket.complete(); await run;
});

test('a final message item alone does not finish an active turn or relay a later failure', async t => {
  const f = fixture(t);
  f.monitor.retryBackoffMs = 10000;
  const run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  const socket = f.starts[0].socket;
  socket.emitMessage({ method: 'item/completed', params: { threadId: 'thread-1', turnId: socket.turnId,
    item: { type: 'agentMessage', phase: 'final_answer', text: 'Partial answer before failure' } } });
  await delay(100);
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight'); assert.deepEqual(f.relays, []);
  socket.complete('failed'); await run;
  assert.equal((await f.store.wakeStateFor('first')).status, 'failed'); assert.deepEqual(f.relays, []);
});

test('Contacts pinned to the same app-server thread share one serial lane', async t => {
  const f = fixture(t);
  f.monitor.peers.other = { ...f.monitor.peers.colleague };
  const run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  await f.monitor.onInbound(await f.receive('second', 'other'));
  await delay(100);
  assert.equal(f.starts.length, 1);
  f.starts[0].socket.complete();
  await until(() => f.starts.length === 2);
  f.starts[1].socket.complete(); await run;
  assert.deepEqual(f.relays, ['first', 'second']);
});

test('session journal waits for task_complete after an early final answer item', async t => {
  const f = fixture(t), run = f.monitor.onInbound(await f.receive('first'));
  await until(() => f.starts.length === 1);
  const turnId = f.starts[0].socket.turnId;
  writeFileSync(f.sessionPath, JSON.stringify({ type: 'response_item', payload: {
    type: 'message', role: 'assistant', phase: 'final_answer',
    internal_chat_message_metadata_passthrough: { turn_id: turnId }, content: [{ text: 'Journal answer' }],
  } }) + '\n');
  await until(() => f.requests.some(r => r.method === 'thread/read'));
  assert.equal((await f.store.wakeStateFor('first')).status, 'inflight');
  assert.deepEqual(f.relays, []);
  appendFileSync(f.sessionPath, JSON.stringify({ type: 'event_msg', payload: {
    type: 'task_complete', turn_id: turnId, last_agent_message: 'Journal answer',
  } }) + '\n');
  await run;
  assert.equal(f.starts.length, 1); assert.deepEqual(f.relays, ['first']);
});

test('turn observation supports legacy history and paginated app-server threads', async () => {
  const client = new CodexAppServerClient({ socketPath: '/unused-test.sock' });
  const target = { id: 'accepted', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'answer' }] };
  client.request = async () => ({ thread: { id: 'thread-1', turns: [target] } });
  assert.deepEqual(await client.readTurn('thread-1', 'accepted'), target);
  const calls = [];
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') throw new Error('thread uses paginated history; includeTurns unsupported');
    return params.cursor ? { data: [target], nextCursor: null } : { data: [], nextCursor: 'next' };
  };
  assert.deepEqual(await client.readTurn('thread-1', 'accepted'), target);
  assert.deepEqual(calls, [
    { method: 'thread/read', params: { threadId: 'thread-1', includeTurns: true } },
    { method: 'thread/turns/list', params: { threadId: 'thread-1', limit: 50, sortDirection: 'desc', itemsView: 'full' } },
    { method: 'thread/turns/list', params: { threadId: 'thread-1', limit: 50, sortDirection: 'desc', itemsView: 'full', cursor: 'next' } },
  ]);
});
