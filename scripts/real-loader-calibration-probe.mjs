#!/usr/bin/env node
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [loaderPath, extensionPath, routeMode, cwd] = process.argv.slice(2);
if (loaderPath === undefined || extensionPath === undefined || cwd === undefined) {
  throw new Error(
    'usage: real-loader-calibration-probe.mjs <loader> <extension> <default|explicit> <cwd>',
  );
}
if (routeMode !== 'default' && routeMode !== 'explicit') {
  throw new Error(`unsupported route mode: ${String(routeMode)}`);
}

class ProbeEventBus {
  listeners = new Map();

  on(channel, handler) {
    let handlers = this.listeners.get(channel);
    if (handlers === undefined) {
      handlers = new Set();
      this.listeners.set(channel, handlers);
    }
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  emit(channel, data) {
    for (const handler of [...(this.listeners.get(channel) ?? [])]) handler(data);
  }
}

const REQUEST_CHANNEL = 'pi-background-tasks:external-request:v2';
const RESPONSE_CHANNEL = 'pi-background-tasks:external-response:v2';
const RESPONSE_SCHEMA = 'pi-background-tasks.external-response.v2';

const bus = new ProbeEventBus();
let nextTask = 0;
const taskSequences = new Map();

function respond(frame, result) {
  bus.emit(RESPONSE_CHANNEL, {
    schema_version: RESPONSE_SCHEMA,
    request_id: frame.request_id,
    operation: frame.operation,
    ok: true,
    result,
  });
}

bus.on(REQUEST_CHANNEL, (frame) => {
  if (frame.operation === 'handshake') {
    respond(frame, {
      api_version: 2,
      register: true,
      update: true,
      log: true,
      cancel: true,
      cancel_ack: true,
      settle: true,
      status: true,
      kill: true,
      terminal_after_settle: true,
      service_id: 'real-loader-calibration-probe',
      owner_id: frame.payload.owner_id,
      owner_token: 'probe-token',
    });
    return;
  }

  if (frame.operation === 'register') {
    nextTask += 1;
    const taskId = `t${String(nextTask)}`;
    taskSequences.set(taskId, 1);
    respond(frame, {
      task: {
        id: taskId,
        name: frame.payload.name,
        status: 'running',
        owner: { id: frame.payload.owner_id, ref: frame.payload.owner_ref },
        outputPath: join(cwd, '.pi', 'tasks', `${taskId}.output`),
      },
      next_sequence: 1,
    });
    return;
  }

  if (
    frame.operation === 'log' ||
    frame.operation === 'update' ||
    frame.operation === 'cancel_ack' ||
    frame.operation === 'settle'
  ) {
    const taskId = frame.payload.task_id;
    const nextSequence = taskSequences.get(taskId) + 1;
    taskSequences.set(taskId, nextSequence);
    respond(frame, {
      task: {
        id: taskId,
        name: 'calibration probe',
        status: frame.operation === 'settle' ? frame.payload.status : 'running',
      },
      next_sequence: nextSequence,
    });
    return;
  }

  if (frame.operation === 'status') {
    respond(frame, { tasks: [] });
    return;
  }

  if (frame.operation === 'kill') {
    respond(frame, {
      task: { id: frame.payload.task_id, name: 'calibration probe', status: 'running' },
    });
    return;
  }

  throw new Error(`probe service received unsupported operation ${String(frame.operation)}`);
});

await mkdir(cwd, { recursive: true });
const fakeBin = join(cwd, 'bin');
await mkdir(fakeBin, { recursive: true });
const fakePi = join(fakeBin, 'pi');
await writeFile(fakePi, '#!/bin/sh\ncat >/dev/null\nsleep 300\n', 'utf8');
await chmod(fakePi, 0o755);
process.env['PATH'] = `${fakeBin}:${process.env['PATH']}`;

const host = await import(pathToFileURL(resolve(loaderPath)).href);
const runtime = host.createExtensionRuntime();
runtime.getThinkingLevel = () => 'medium';
const loaded = await host.loadExtensions([resolve(extensionPath)], cwd, bus, runtime);
if (loaded.errors.length !== 0) {
  throw new Error(JSON.stringify(loaded.errors));
}
const extension = loaded.extensions[0];
if (extension === undefined) throw new Error('real loader returned no extension');

const defaultRoute = {
  provider: 'zai-coding-cn',
  id: 'glm-5.3',
  contextWindow: 200_000,
};
const calibratedRoute = {
  provider: 'openai-codex',
  id: 'gpt-5.6-sol',
  contextWindow: 200_000,
};
const entries = [
  {
    id: 'e1',
    parentId: null,
    type: 'message',
    message: { role: 'user', content: 'parent context' },
  },
];
const ctx = {
  cwd,
  hasUI: false,
  ui: { notify() {} },
  model: defaultRoute,
  modelRegistry: {
    getAll: () => [defaultRoute, calibratedRoute],
  },
  sessionManager: {
    getLeafId: () => 'e1',
    getLeafEntry: () => entries[0],
    getEntries: () => entries,
    getSessionId: () => 'real-loader-probe-parent',
  },
  getSystemPrompt: () => 'real loader calibration probe system prompt',
};

for (const handler of extension.handlers.get('session_start') ?? []) {
  await handler({ type: 'session_start', reason: 'startup' }, ctx);
}

const registeredTool = extension.tools.get('subagent_run');
if (registeredTool === undefined) throw new Error('subagent_run was not registered');
const definition = registeredTool.definition;
const rawParams =
  routeMode === 'explicit'
    ? {
        name: 'Calibration probe',
        prompt: 'Return one word.',
        route: { provider: calibratedRoute.provider, model: calibratedRoute.id },
      }
    : { name: 'Calibration probe', prompt: 'Return one word.' };
const params = definition.prepareArguments(rawParams);

let outcome;
try {
  const result = await definition.execute(
    'call-calibration-probe',
    params,
    undefined,
    undefined,
    ctx,
  );
  const artifactDir = result.details.artifact_dir;
  const plan = JSON.parse(await readFile(join(cwd, artifactDir, 'budget-plan.json'), 'utf8'));
  outcome = {
    ok: true,
    taskId: result.details.task_id,
    route: result.details.route.qualified_id,
    calibrationVersion: plan.policy.calibration_version,
  };
} catch (error) {
  outcome = {
    ok: false,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  };
}

for (const handler of extension.handlers.get('session_shutdown') ?? []) {
  await handler({ type: 'session_shutdown', reason: 'quit' }, ctx);
}

process.stdout.write(`${JSON.stringify(outcome)}\n`);
