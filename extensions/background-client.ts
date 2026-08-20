import { randomBytes } from 'node:crypto';
import type { EventBus } from '@earendil-works/pi-coding-agent';

/**
 * Client for the pi-background-tasks external-task EventBus v2 service.
 *
 * The background package owns the task registry, dock, notifications, and
 * terminal delivery. This package is an owner client of that service: it
 * completes a unique compatible handshake at session start, registers external
 * work, appends logs, routes cancellation acknowledgements, and settles terminal
 * state. It never instantiates its own registry or notification path.
 *
 * Frame shapes are closed and mirror the documented service contract; a service
 * that answers with an unexpected shape is a typed protocol failure, never a
 * silent success.
 */

export const V2_REQUEST_CHANNEL = 'pi-background-tasks:external-request:v2';
export const V2_RESPONSE_CHANNEL = 'pi-background-tasks:external-response:v2';
export const V2_CANCEL_CHANNEL = 'pi-background-tasks:external-cancel:v2';
export const V2_TERMINAL_CHANNEL = 'pi-background-tasks:external-terminal:v2';
export const V2_REQUEST_SCHEMA = 'pi-background-tasks.external-request.v2';
export const V2_RESPONSE_SCHEMA = 'pi-background-tasks.external-response.v2';
export const V2_CANCEL_SCHEMA = 'pi-background-tasks.external-cancel.v2';
export const V2_TERMINAL_SCHEMA = 'pi-background-tasks.external-terminal.v2';

export const SUBAGENT_OWNER_PROTOCOL_VERSION = 2;

/** Capabilities the subagent owner requires of the service. */
export interface RequiredExternalCapabilities {
  api_version: 2;
  register: true;
  update: true;
  log: true;
  cancel: true;
  cancel_ack: true;
  settle: true;
  status: true;
  kill: true;
  terminal_after_settle: true;
}

export type BackgroundServiceErrorCode =
  | 'handshake_absent'
  | 'handshake_duplicate'
  | 'handshake_rejected'
  | 'service_incompatible'
  | 'request_failed'
  | 'request_timeout'
  | 'protocol_violation';

export class BackgroundServiceError extends Error {
  readonly code: BackgroundServiceErrorCode;

  constructor(code: BackgroundServiceErrorCode, message: string) {
    super(message);
    this.name = 'BackgroundServiceError';
    this.code = code;
  }

  static describe(): string {
    return 'pi-background-tasks service error';
  }
}

export interface ExternalTaskOwnerRef {
  id: string;
  ref: string;
}

/** The generic snapshot fields the subagent owner consumes. */
export interface ExternalTaskSnapshot {
  id: string;
  name: string;
  status: string;
  owner?: ExternalTaskOwnerRef | undefined;
  outputPath?: string | undefined;
  description?: string | undefined;
  [key: string]: unknown;
}

export interface RegisterOptions {
  ownerRef: string;
  name: string;
  description?: string | undefined;
  cancellable: boolean;
  rerunnable: boolean;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
  stopWaitMs?: number | undefined;
}

export interface RegisterResult {
  task: ExternalTaskSnapshot;
  nextSequence: number;
}

export interface SequencedOpResult {
  task: ExternalTaskSnapshot;
  nextSequence: number;
}

export interface CancelFrame {
  serviceId: string;
  ownerId: string;
  ownerRef: string;
  taskId: string;
  cancelId: string;
  reason: string;
}

interface RawResponse {
  schema_version: string;
  request_id: string;
  operation: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRawResponse(value: unknown): value is RawResponse {
  if (!isRecord(value)) return false;
  return (
    value['schema_version'] === V2_RESPONSE_SCHEMA &&
    typeof value['request_id'] === 'string' &&
    typeof value['operation'] === 'string' &&
    typeof value['ok'] === 'boolean'
  );
}

function requireTask(value: unknown): ExternalTaskSnapshot {
  if (!isRecord(value) || typeof value['id'] !== 'string') {
    throw new BackgroundServiceError(
      'protocol_violation',
      'background service returned a result without a task snapshot',
    );
  }
  return value as unknown as ExternalTaskSnapshot;
}

function requireNextSequence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new BackgroundServiceError(
      'protocol_violation',
      'background service returned an invalid next_sequence',
    );
  }
  return value;
}

export interface ConnectOptions {
  /** How long to wait for the first handshake response before declaring the service absent. */
  timeoutMs: number;
  /** Extra wait after the first response so a duplicate service is observed. */
  graceMs: number;
  /** Owner identity fragment; the full owner id also carries random bytes. */
  ownerTag: string;
  /** Per-operation response timeout. Defaults to 10 seconds. */
  requestTimeoutMs?: number | undefined;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class SubagentBackgroundClient {
  readonly serviceId: string;
  readonly ownerId: string;
  private readonly ownerToken: string;
  private readonly events: EventBus;
  private readonly requestTimeoutMs: number;

  private constructor(
    events: EventBus,
    serviceId: string,
    ownerId: string,
    ownerToken: string,
    requestTimeoutMs: number,
  ) {
    this.events = events;
    this.serviceId = serviceId;
    this.ownerId = ownerId;
    this.ownerToken = ownerToken;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * Complete the owner handshake against the one unique compatible service.
   *
   * - zero responses until the timeout: the service is absent.
   * - more than one response: two services are installed.
   * - a failure response: the service rejected the handshake.
   * - a success response with missing capabilities: incompatible version.
   */
  static async connect(
    events: EventBus,
    options: ConnectOptions,
  ): Promise<SubagentBackgroundClient> {
    const ownerId = `pi-subagent:${options.ownerTag}:${randomBytes(8).toString('hex')}`;
    const requestId = `sa-handshake-${randomBytes(8).toString('hex')}`;
    const responses: RawResponse[] = [];

    const decision = new Promise<RawResponse>((resolve, reject) => {
      let decided = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const finish = (action: () => void) => {
        if (decided) return;
        decided = true;
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        off();
        action();
      };
      const decideNow = () => {
        finish(() => {
          if (responses.length === 0) {
            reject(
              new BackgroundServiceError(
                'handshake_absent',
                'pi-subagent requires the pi-background-tasks external-task service, but no service answered the handshake. Install and enable @sakiko233/pi-background-tasks (v3 or newer) before pi-subagent; none of the subagent tools are registered.',
              ),
            );
            return;
          }
          if (responses.length > 1) {
            reject(
              new BackgroundServiceError(
                'handshake_duplicate',
                `pi-subagent found ${String(responses.length)} background-task services answering one handshake; exactly one unique service is required. Remove the duplicate pi-background-tasks installation; none of the subagent tools are registered.`,
              ),
            );
            return;
          }
          resolve(responses[0] as RawResponse);
        });
      };
      const off = events.on(V2_RESPONSE_CHANNEL, (data) => {
        if (!isRawResponse(data)) return;
        if (data.request_id !== requestId || data.operation !== 'handshake') return;
        responses.push(data);
        if (!data.ok) {
          finish(() => {
            reject(
              new BackgroundServiceError(
                'handshake_rejected',
                `pi-background-tasks rejected the subagent handshake: ${data.error ?? 'unknown error'}. None of the subagent tools are registered.`,
              ),
            );
          });
          return;
        }
        if (graceTimer === undefined) {
          graceTimer = setTimeout(decideNow, options.graceMs);
        }
      });
      setTimeout(decideNow, options.timeoutMs);
    });

    events.emit(V2_REQUEST_CHANNEL, {
      schema_version: V2_REQUEST_SCHEMA,
      request_id: requestId,
      operation: 'handshake',
      payload: {
        protocol_version: SUBAGENT_OWNER_PROTOCOL_VERSION,
        owner_id: ownerId,
      },
    });

    const response = await decision;
    const result = isRecord(response.result) ? response.result : undefined;
    if (
      result === undefined ||
      result['api_version'] !== 2 ||
      result['register'] !== true ||
      result['update'] !== true ||
      result['log'] !== true ||
      result['cancel'] !== true ||
      result['cancel_ack'] !== true ||
      result['settle'] !== true ||
      result['status'] !== true ||
      result['kill'] !== true ||
      result['terminal_after_settle'] !== true
    ) {
      throw new BackgroundServiceError(
        'service_incompatible',
        `pi-background-tasks service is incompatible with this version of pi-subagent (api_version or required external-task capabilities missing). Upgrade @sakiko233/pi-background-tasks to v3 or newer; none of the subagent tools are registered.`,
      );
    }
    const serviceId = result['service_id'];
    const ownerToken = result['owner_token'];
    if (typeof serviceId !== 'string' || typeof ownerToken !== 'string') {
      throw new BackgroundServiceError(
        'protocol_violation',
        'background service handshake result lacks service_id or owner_token',
      );
    }
    return new SubagentBackgroundClient(
      events,
      serviceId,
      ownerId,
      ownerToken,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  private identity(): Record<string, unknown> {
    return {
      service_id: this.serviceId,
      owner_id: this.ownerId,
      owner_token: this.ownerToken,
    };
  }

  private async request(
    operation: string,
    payload: Record<string, unknown>,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<Record<string, unknown>> {
    const requestId = `sa-${operation}-${randomBytes(8).toString('hex')}`;
    const response = await new Promise<RawResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(
          new BackgroundServiceError(
            'request_timeout',
            `pi-background-tasks service did not answer ${operation} within ${String(timeoutMs)}ms`,
          ),
        );
      }, timeoutMs);
      const off = this.events.on(V2_RESPONSE_CHANNEL, (data) => {
        if (!isRawResponse(data)) return;
        if (data.request_id !== requestId) return;
        clearTimeout(timeout);
        off();
        resolve(data);
      });
      this.events.emit(V2_REQUEST_CHANNEL, {
        schema_version: V2_REQUEST_SCHEMA,
        request_id: requestId,
        operation,
        payload,
      });
    });
    if (!response.ok) {
      throw new BackgroundServiceError(
        'request_failed',
        `pi-background-tasks rejected ${operation}: ${response.error ?? 'unknown error'}`,
      );
    }
    if (!isRecord(response.result)) {
      throw new BackgroundServiceError(
        'protocol_violation',
        `pi-background-tasks returned a malformed ${operation} result`,
      );
    }
    return response.result;
  }

  async register(options: RegisterOptions): Promise<RegisterResult> {
    const result = await this.request('register', {
      ...this.identity(),
      owner_ref: options.ownerRef,
      name: options.name,
      // Optional keys are omitted, never sent as undefined: the service treats
      // a present key with an undefined value as a contract violation.
      ...(options.description === undefined ? {} : { description: options.description }),
      capabilities: {
        cancellable: options.cancellable,
        rerunnable: options.rerunnable,
      },
      notify_on_completion: options.notifyOnCompletion,
      trigger_on_completion: options.triggerOnCompletion,
      ...(options.stopWaitMs === undefined ? {} : { stop_wait_ms: options.stopWaitMs }),
    });
    return {
      task: requireTask(result['task']),
      nextSequence: requireNextSequence(result['next_sequence']),
    };
  }

  async log(taskId: string, sequence: number, text: string): Promise<SequencedOpResult> {
    const result = await this.request('log', {
      ...this.identity(),
      task_id: taskId,
      sequence,
      text,
    });
    return {
      task: requireTask(result['task']),
      nextSequence: requireNextSequence(result['next_sequence']),
    };
  }

  async update(
    taskId: string,
    sequence: number,
    update: { name?: string | undefined; description?: string | undefined },
  ): Promise<SequencedOpResult> {
    const payload: Record<string, unknown> = {
      ...this.identity(),
      task_id: taskId,
      sequence,
    };
    if (update.name !== undefined) payload['name'] = update.name;
    if (update.description !== undefined) payload['description'] = update.description;
    const result = await this.request('update', payload);
    return {
      task: requireTask(result['task']),
      nextSequence: requireNextSequence(result['next_sequence']),
    };
  }

  async cancelAck(taskId: string, sequence: number, cancelId: string): Promise<SequencedOpResult> {
    const result = await this.request('cancel_ack', {
      ...this.identity(),
      task_id: taskId,
      sequence,
      cancel_id: cancelId,
    });
    return {
      task: requireTask(result['task']),
      nextSequence: requireNextSequence(result['next_sequence']),
    };
  }

  async settle(
    taskId: string,
    sequence: number,
    status: 'completed' | 'failed' | 'killed',
    error?: string | undefined,
  ): Promise<SequencedOpResult> {
    const result = await this.request('settle', {
      ...this.identity(),
      task_id: taskId,
      sequence,
      status,
      ...(error === undefined ? {} : { error }),
    });
    return {
      task: requireTask(result['task']),
      nextSequence: requireNextSequence(result['next_sequence']),
    };
  }

  async status(taskId: string): Promise<ExternalTaskSnapshot> {
    const result = await this.request('status', {
      ...this.identity(),
      task_id: taskId,
    });
    const tasks = result['tasks'];
    if (!Array.isArray(tasks) || tasks.length !== 1) {
      throw new BackgroundServiceError(
        'protocol_violation',
        'background service status returned an unexpected task list',
      );
    }
    return requireTask(tasks[0]);
  }

  async kill(taskId: string): Promise<ExternalTaskSnapshot> {
    const result = await this.request('kill', {
      ...this.identity(),
      task_id: taskId,
    });
    return requireTask(result['task']);
  }

  /** Subscribe to cancellation frames routed to this owner session. */
  onCancellation(handler: (frame: CancelFrame) => void): () => void {
    return this.events.on(V2_CANCEL_CHANNEL, (data) => {
      if (!isRecord(data)) return;
      if (data['schema_version'] !== V2_CANCEL_SCHEMA) return;
      if (data['service_id'] !== this.serviceId || data['owner_id'] !== this.ownerId) return;
      const taskId = data['task_id'];
      const cancelId = data['cancel_id'];
      const ownerRef = data['owner_ref'];
      const reason = data['reason'];
      if (
        typeof taskId !== 'string' ||
        typeof cancelId !== 'string' ||
        typeof ownerRef !== 'string' ||
        typeof reason !== 'string'
      ) {
        return;
      }
      handler({
        serviceId: this.serviceId,
        ownerId: this.ownerId,
        ownerRef,
        taskId,
        cancelId,
        reason,
      });
    });
  }
}
