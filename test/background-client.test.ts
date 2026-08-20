import { randomBytes } from 'node:crypto';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  type CancelFrame,
  type ExternalTaskSnapshot,
  SubagentBackgroundClient,
  V2_CANCEL_CHANNEL,
  V2_REQUEST_CHANNEL,
  V2_REQUEST_SCHEMA,
  V2_RESPONSE_CHANNEL,
  V2_RESPONSE_SCHEMA,
} from '../extensions/background-client.js';

class MemoryEventBus implements EventBus {
  readonly delivered: Array<{ channel: string; data: unknown }> = [];
  private readonly listeners = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    this.delivered.push({ channel, data });
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    let listeners = this.listeners.get(channel);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
    }
    listeners.add(handler);
    return () => listeners?.delete(handler);
  }
}

interface Frame {
  schema_version: string;
  request_id: string;
  operation: string;
  payload?: Record<string, unknown>;
}

interface StubTask {
  id: string;
  name: string;
  ownerRef: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  logs: string[];
  sequence: number;
  cancelRequested: boolean;
  cancelId?: string;
  cancellable: boolean;
}

/**
 * Minimal faithful stub of the background-tasks external-task v2 service.
 *
 * It mirrors the closed-frame validation, sequence, and cancellation semantics
 * documented for the real service so client behavior is exercised against the
 * contract, not against leniency.
 */
class StubService {
  readonly bus: EventBus;
  readonly serviceId = `stub-${randomBytes(6).toString('hex')}`;
  owners = new Map<string, { token: string }>();
  tasks = new Map<string, StubTask>();
  seenRequestIds = new Set<string>();
  nextId = 0;
  frames: Frame[] = [];
  rejectOwnerPrefix: string | undefined;
  private readonly off: () => void;

  constructor(bus: EventBus) {
    this.bus = bus;
    this.off = bus.on(V2_REQUEST_CHANNEL, (data) => this.handle(data));
  }

  close(): void {
    this.off();
  }

  private assertClosed(payload: Record<string, unknown>, allowed: readonly string[], op: string) {
    for (const key of Object.keys(payload)) {
      if (!allowed.includes(key)) throw new Error(`${op}.payload contains unknown key ${key}`);
    }
  }

  private handle(data: unknown): void {
    const frame = data as Frame;
    this.frames.push(frame);
    if (frame.schema_version !== V2_REQUEST_SCHEMA) {
      this.respond(frame.request_id, frame.operation, false, undefined, 'schema mismatch');
      return;
    }
    if (this.seenRequestIds.has(frame.request_id)) {
      this.respond(frame.request_id, frame.operation, false, undefined, 'duplicate request_id');
      return;
    }
    this.seenRequestIds.add(frame.request_id);
    const payload = frame.payload ?? {};
    try {
      const result = this.execute(frame.operation, payload, frame.request_id);
      this.respond(frame.request_id, frame.operation, true, result);
    } catch (error) {
      this.respond(
        frame.request_id,
        frame.operation,
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private execute(
    operation: string,
    payload: Record<string, unknown>,
    _requestId: string,
  ): Record<string, unknown> {
    if (operation === 'handshake') {
      this.assertClosed(payload, ['protocol_version', 'owner_id'], 'handshake');
      if (payload['protocol_version'] !== 2) throw new Error('protocol_version must be 2');
      const ownerId = String(payload['owner_id']);
      if (this.rejectOwnerPrefix !== undefined && ownerId.startsWith(this.rejectOwnerPrefix)) {
        throw new Error(`owner ${ownerId} already handshook`);
      }
      if (this.owners.has(ownerId)) throw new Error(`owner ${ownerId} already handshook`);
      const token = randomBytes(8).toString('hex');
      this.owners.set(ownerId, { token });
      return {
        api_version: 2,
        register: true,
        update: true,
        log: true,
        cancel: true,
        cancel_ack: true,
        settle: true,
        status: true,
        logs: true,
        logs_bounded: true,
        kill: true,
        terminal_after_settle: true,
        service_id: this.serviceId,
        owner_id: ownerId,
        owner_token: token,
      };
    }
    const owner = this.owners.get(String(payload['owner_id']));
    if (owner === undefined) throw new Error('unknown owner');
    if (payload['service_id'] !== this.serviceId) throw new Error('service_id mismatch');
    if (payload['owner_token'] !== owner.token) throw new Error('owner_token mismatch');
    if (operation === 'register') {
      this.assertClosed(
        payload,
        [
          'service_id',
          'owner_id',
          'owner_token',
          'owner_ref',
          'name',
          'description',
          'capabilities',
          'notify_on_completion',
          'trigger_on_completion',
          'stop_wait_ms',
        ],
        'register',
      );
      const ownerRef = String(payload['owner_ref']);
      for (const task of this.tasks.values()) {
        if (task.ownerRef === ownerRef) throw new Error(`owner reference ${ownerRef} registered`);
      }
      const capabilities = payload['capabilities'] as { cancellable: boolean; rerunnable: boolean };
      this.nextId += 1;
      const id = `t${String(this.nextId)}`;
      this.tasks.set(id, {
        id,
        name: String(payload['name']),
        ownerRef,
        status: 'running',
        logs: [],
        sequence: 1,
        cancelRequested: false,
        cancellable: capabilities.cancellable,
      });
      return { task: this.snapshot(id), next_sequence: 1 };
    }
    const taskId = String(payload['task_id']);
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error('unknown task');
    const sequenced = ['log', 'update', 'cancel_ack', 'settle'];
    if (sequenced.includes(operation)) {
      const sequence = Number(payload['sequence']);
      if (sequence !== task.sequence) {
        throw new Error(`expected sequence ${String(task.sequence)}, got ${String(sequence)}`);
      }
      task.sequence += 1;
    }
    if (operation === 'log') {
      task.logs.push(String(payload['text']));
      return { task: this.snapshot(taskId), next_sequence: task.sequence };
    }
    if (operation === 'update') {
      if (typeof payload['name'] === 'string') task.name = String(payload['name']);
      return { task: this.snapshot(taskId), next_sequence: task.sequence };
    }
    if (operation === 'status') {
      return { tasks: [this.snapshot(taskId)] };
    }
    if (operation === 'kill') {
      if (!task.cancellable) throw new Error('task is not cancellable');
      task.cancelRequested = true;
      task.cancelId = randomBytes(6).toString('hex');
      this.bus.emit(V2_CANCEL_CHANNEL, {
        schema_version: 'pi-background-tasks.external-cancel.v2',
        service_id: this.serviceId,
        owner_id: payload['owner_id'],
        owner_ref: task.ownerRef,
        task_id: taskId,
        cancel_id: task.cancelId,
        reason: 'user',
      });
      return { task: this.snapshot(taskId), message: 'kill requested' };
    }
    if (operation === 'cancel_ack') {
      if (task.cancelId !== payload['cancel_id']) throw new Error('cancel_id mismatch');
      return { task: this.snapshot(taskId), next_sequence: task.sequence };
    }
    if (operation === 'settle') {
      const status = String(payload['status']);
      if (status !== 'completed' && status !== 'failed' && status !== 'killed') {
        throw new Error('bad settle status');
      }
      if (task.cancelRequested && status !== 'killed') {
        throw new Error('cancellation must settle as killed');
      }
      task.status = status;
      return { task: this.snapshot(taskId), next_sequence: task.sequence };
    }
    throw new Error('unsupported operation');
  }

  snapshot(id: string): ExternalTaskSnapshot {
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error('unknown task');
    return {
      id: task.id,
      name: task.name,
      status: task.status,
      owner: { id: 'pi-subagent-owner', ref: task.ownerRef },
      outputPath: `.pi/tasks/${task.id}.output`,
    };
  }

  private respond(
    requestId: string,
    operation: string,
    ok: boolean,
    result?: Record<string, unknown>,
    error?: string,
  ): void {
    this.bus.emit(V2_RESPONSE_CHANNEL, {
      schema_version: V2_RESPONSE_SCHEMA,
      request_id: requestId,
      operation,
      ok,
      ...(ok ? { result } : { error }),
    });
  }
}

const connectDefaults = { timeoutMs: 300, graceMs: 20 };

async function connect(bus: EventBus, ownerTag = 'test-owner') {
  return SubagentBackgroundClient.connect(bus, { ...connectDefaults, ownerTag });
}

describe('subagent background client handshake', () => {
  it('completes the handshake with one unique compatible service', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connect(bus, 'owner-a');
    expect(client.serviceId).toBe(service.serviceId);
    expect(client.ownerId).toContain('owner-a');
    const handshake = bus.delivered.find((entry) => entry.channel === V2_REQUEST_CHANNEL)
      ?.data as Frame;
    expect(handshake.operation).toBe('handshake');
    expect(handshake.payload?.['protocol_version']).toBe(2);
    expect(typeof handshake.payload?.['owner_id']).toBe('string');
    const second = await connect(bus, 'owner-b');
    expect(second.ownerId).not.toBe(client.ownerId);
  });

  it('rejects a missing service with a typed absent error', async () => {
    const bus = new MemoryEventBus();
    await expect(connect(bus)).rejects.toMatchObject({
      name: 'BackgroundServiceError',
      code: 'handshake_absent',
    });
  });

  it('rejects two services answering one handshake', async () => {
    const bus = new MemoryEventBus();
    new StubService(bus);
    new StubService(bus);
    await expect(connect(bus)).rejects.toMatchObject({
      code: 'handshake_duplicate',
    });
  });

  it('rejects a service error and an incompatible service', async () => {
    const bus = new MemoryEventBus();
    const rejecting = new StubService(bus);
    rejecting.rejectOwnerPrefix = 'pi-subagent:owner-a:';
    await expect(connect(bus, 'owner-a')).rejects.toMatchObject({
      code: 'handshake_rejected',
    });

    const incompatibleBus = new MemoryEventBus();
    incompatibleBus.on(V2_REQUEST_CHANNEL, (data) => {
      const frame = data as Frame;
      incompatibleBus.emit(V2_RESPONSE_CHANNEL, {
        schema_version: V2_RESPONSE_SCHEMA,
        request_id: frame.request_id,
        operation: 'handshake',
        ok: true,
        result: {
          api_version: 1,
          service_id: 'old-service',
          owner_id: frame.payload?.['owner_id'],
          owner_token: 'tok',
        },
      });
    });
    await expect(connect(incompatibleBus)).rejects.toMatchObject({
      code: 'service_incompatible',
    });
  });
});

describe('subagent background client operations', () => {
  it('registers external work and tracks per-task sequences', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connect(bus);
    const registered = await client.register({
      ownerRef: `s${'a'.repeat(32)}`,
      name: 'Investigate flake',
      description: 'subagent inspect run',
      cancellable: true,
      rerunnable: false,
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    expect(registered.task.id).toBe('t1');
    expect(registered.task.status).toBe('running');
    expect(registered.nextSequence).toBe(1);
    const afterLog = await client.log(registered.task.id, 1, 'launched child pid 42');
    expect(afterLog.nextSequence).toBe(2);
    expect(service.tasks.get('t1')?.logs).toEqual(['launched child pid 42']);
    const afterUpdate = await client.update(registered.task.id, 2, {
      name: 'Investigate flake (deep)',
    });
    expect(afterUpdate.task.name).toBe('Investigate flake (deep)');
    const afterSettle = await client.settle(registered.task.id, 3, 'completed');
    expect(afterSettle.task.status).toBe('completed');
    expect(service.tasks.get('t1')?.sequence).toBe(4);
  });

  it('surfaces service rejections and duplicate sequences as typed errors', async () => {
    const bus = new MemoryEventBus();
    new StubService(bus);
    const client = await connect(bus);
    const registered = await client.register({
      ownerRef: `s${'a'.repeat(32)}`,
      name: 'task',
      cancellable: true,
      rerunnable: false,
      notifyOnCompletion: true,
      triggerOnCompletion: true,
    });
    await expect(client.log(registered.task.id, 1, 'one')).resolves.toMatchObject({
      nextSequence: 2,
    });
    await expect(client.log(registered.task.id, 1, 'replay')).rejects.toMatchObject({
      name: 'BackgroundServiceError',
      code: 'request_failed',
    });
    await expect(client.settle('unknown-task', 1, 'completed')).rejects.toMatchObject({
      code: 'request_failed',
    });
  });

  it('routes cancellation frames for the owning session only', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await connect(bus);
    const cancelFrames: CancelFrame[] = [];
    const off = client.onCancellation((frame) => cancelFrames.push(frame));
    const registered = await client.register({
      ownerRef: `s${'b'.repeat(32)}`,
      name: 'cancellable task',
      cancellable: true,
      rerunnable: false,
      notifyOnCompletion: true,
      triggerOnCompletion: false,
    });
    await client.kill(registered.task.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelFrames).toHaveLength(1);
    expect(cancelFrames[0]?.taskId).toBe(registered.task.id);
    expect(cancelFrames[0]?.serviceId).toBe(service.serviceId);
    expect(cancelFrames[0]?.reason).toBe('user');
    const frame = cancelFrames[0];
    if (frame === undefined) throw new Error('expected a cancel frame');
    await client.cancelAck(registered.task.id, 1, frame.cancelId);
    await client.settle(registered.task.id, 2, 'killed');
    expect(service.tasks.get(registered.task.id)?.status).toBe('killed');
    off();
  });

  it('fails closed when the service stops answering operations', async () => {
    const bus = new MemoryEventBus();
    const service = new StubService(bus);
    const client = await SubagentBackgroundClient.connect(bus, {
      ...connectDefaults,
      ownerTag: 'owner-timeout',
      requestTimeoutMs: 100,
    });
    service.close();
    await expect(
      client.register({
        ownerRef: `s${'c'.repeat(32)}`,
        name: 'task',
        cancellable: true,
        rerunnable: false,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      }),
    ).rejects.toMatchObject({
      name: 'BackgroundServiceError',
      code: 'request_timeout',
    });
  });
});
