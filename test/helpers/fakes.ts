import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import {
  type ExternalTaskSnapshot,
  V2_CANCEL_CHANNEL,
  V2_REQUEST_CHANNEL,
  V2_REQUEST_SCHEMA,
  V2_RESPONSE_CHANNEL,
  V2_RESPONSE_SCHEMA,
} from '../../extensions/background-client.js';

/**
 * Shared test doubles for runner/entrypoint tests.
 *
 * The stub service mirrors the documented pi-background-tasks external-task v2
 * contract (closed frames, per-task sequences, cancellation routing) so the
 * supervisor is exercised against the contract, not against leniency. The fake
 * child is a scriptable process stand-in: tests decide exactly when it closes
 * and what it committed beforehand.
 */

export class MemoryEventBus implements EventBus {
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
    return () => listeners?.delete(handler) ?? false;
  }
}

export interface StubFrame {
  schema_version: string;
  request_id: string;
  operation: string;
  payload?: Record<string, unknown>;
}

export interface StubTask {
  id: string;
  name: string;
  ownerRef: string;
  ownerId: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  error?: string;
  logs: string[];
  sequence: number;
  cancelRequested: boolean;
  cancelId?: string;
  cancellable: boolean;
}

export class StubService {
  readonly bus: MemoryEventBus;
  readonly serviceId = `stub-${randomBytes(6).toString('hex')}`;
  owners = new Map<string, { token: string }>();
  tasks = new Map<string, StubTask>();
  seenRequestIds = new Set<string>();
  nextId = 0;
  frames: StubFrame[] = [];
  rejectOperations = new Set<string>();
  private readonly off: () => void;

  constructor(bus: MemoryEventBus) {
    this.bus = bus;
    this.off = bus.on(V2_REQUEST_CHANNEL, (data) => this.handle(data));
  }

  close(): void {
    this.off();
  }

  /** Emit a cancellation frame exactly the way the real registry does. */
  publishCancellation(taskId: string, reason: string): string {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`unknown stub task ${taskId}`);
    task.cancelRequested = true;
    task.cancelId = randomBytes(12).toString('hex');
    this.bus.emit(V2_CANCEL_CHANNEL, {
      schema_version: 'pi-background-tasks.external-cancel.v2',
      service_id: this.serviceId,
      owner_id: task.ownerId,
      owner_ref: task.ownerRef,
      task_id: task.id,
      cancel_id: task.cancelId,
      reason,
    });
    return task.cancelId;
  }

  private handle(data: unknown): void {
    const frame = data as StubFrame;
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
      const result = this.execute(frame.operation, payload);
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

  private execute(operation: string, payload: Record<string, unknown>): Record<string, unknown> {
    if (this.rejectOperations.has(operation)) throw new Error(`${operation} rejected by stub`);
    if (operation === 'handshake') {
      if (payload['protocol_version'] !== 2) throw new Error('protocol_version must be 2');
      const ownerId = String(payload['owner_id']);
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
      const ownerRef = String(payload['owner_ref']);
      for (const task of this.tasks.values()) {
        if (task.ownerRef === ownerRef) throw new Error(`owner reference ${ownerRef} registered`);
      }
      const capabilities = payload['capabilities'] as { cancellable: boolean; rerunnable: boolean };
      this.nextId += 1;
      const taskId = `t${String(this.nextId)}`;
      this.tasks.set(taskId, {
        id: taskId,
        name: String(payload['name']),
        ownerRef,
        ownerId: String(payload['owner_id']),
        status: 'running',
        logs: [],
        sequence: 1,
        cancelRequested: false,
        cancellable: capabilities.cancellable,
      });
      return { task: this.snapshot(taskId), next_sequence: 1 };
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
      this.publishCancellation(taskId, 'user');
      return { task: this.snapshot(taskId), next_sequence: task.sequence };
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
      if (typeof payload['error'] === 'string') task.error = payload['error'];
      return { task: this.snapshot(taskId), next_sequence: task.sequence };
    }
    throw new Error('unsupported operation');
  }

  snapshot(taskId: string): ExternalTaskSnapshot {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error('unknown task');
    return {
      id: task.id,
      name: task.name,
      status: task.status,
      owner: { id: task.ownerId, ref: task.ownerRef },
      outputPath: `.pi/tasks/${task.id}.output`,
    };
  }

  operationsFor(taskId: string): string[] {
    return this.frames
      .filter((frame) => frame.payload?.['task_id'] === taskId)
      .map((frame) => frame.operation);
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

/** Minimal child process stand-in with a scriptable close. */
export class FakeChild {
  readonly pid = 4242;
  readonly stdinChunks: Buffer[] = [];
  stdinEnded = false;
  readonly killedSignals: Array<string | undefined> = [];
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: (data: Buffer, callback?: (error?: Error | null) => void): boolean => {
      this.stdinChunks.push(data);
      callback?.(null);
      return true;
    },
    end: (callback?: () => void): void => {
      this.stdinEnded = true;
      callback?.();
    },
    once: (event: string, listener: (error: Error) => void): void => {
      if (event === 'error') this.stdinErrorListener = listener;
    },
  };
  private readonly emitter = new EventEmitter();
  private stdinErrorListener: ((error: Error) => void) | undefined;

  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: string, listener: (...args: never[]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedSignals.push(signal);
    return true;
  }

  emitStdout(text: string): void {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }

  emitStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text, 'utf8'));
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emitter.emit('close', code, signal);
  }

  failSpawn(error: Error): void {
    this.emitter.emit('error', error);
  }

  failStdin(error: Error): void {
    this.stdinErrorListener?.(error);
  }
}

export interface FakeSpawnCall {
  command: string;
  args: string[];
  options: {
    env?: NodeJS.ProcessEnv | undefined;
    cwd?: string | URL | undefined;
    detached?: boolean | undefined;
  };
}

export interface FakeSpawn {
  calls: FakeSpawnCall[];
  children: FakeChild[];
  next: (call: FakeSpawnCall) => FakeChild;
}

/** Default fake spawn: one queued FakeChild per call, or a fresh one when unqueued. */
export function makeFakeSpawn(): {
  spawn: (command: string, args: string[], options: FakeSpawnCall['options']) => FakeChild;
  fake: FakeSpawn;
} {
  const fake: FakeSpawn = {
    calls: [],
    children: [],
    next: () => new FakeChild(),
  };
  return {
    fake,
    spawn: (command, args, options) => {
      const call: FakeSpawnCall = { command, args, options: options ?? {} };
      fake.calls.push(call);
      const child = fake.next(call);
      fake.children.push(child);
      return child;
    },
  };
}

export interface CapturedTool {
  name: string;
  parameters: Record<string, unknown>;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: never,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
    usage?: unknown;
  }>;
}

/** Minimal ExtensionAPI stand-in capturing tool registrations and event handlers. */
export class StubPi {
  readonly events: EventBus;
  readonly tools = new Map<string, CapturedTool>();
  readonly sentMessages: Array<{ message: Record<string, unknown>; options: unknown }> = [];
  private readonly handlers = new Map<string, Array<(...args: never[]) => unknown>>();

  constructor(events: EventBus) {
    this.events = events as MemoryEventBus;
  }

  registerTool(definition: CapturedTool): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool ${definition.name} registered twice`);
    }
    this.tools.set(definition.name, definition);
  }

  on(event: string, handler: (...args: never[]) => unknown): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  getThinkingLevel(): string {
    return 'medium';
  }

  sendMessage(message: Record<string, unknown>, options: unknown): void {
    this.sentMessages.push({ message, options });
  }

  async emitSessionEvent(event: 'session_start' | 'session_shutdown', ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({} as never, ctx as never);
    }
  }
}
