import { describe, expect, it } from 'vitest';
import {
  assertWellFormedUtf8,
  buildSubagentResultPackage,
  serializeSubagentResultPackage,
  verifySubagentResultPackage,
} from '../extensions/result-package.js';
import { SubagentError } from '../extensions/types.js';

const expectation = {
  taskId: 's' + 'a'.repeat(32),
  launchNonce: 'n'.repeat(32),
  seedSha256: 'f'.repeat(64),
  route: { provider: 'test-provider', model: 'test-model' },
};

const observedUsage = {
  input: 120,
  output: 80,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: 215,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.01, total: 0.32 },
};

function buildPackage(answerBlocks: readonly string[], route = expectation.route) {
  return buildSubagentResultPackage({
    taskId: expectation.taskId,
    launchNonce: expectation.launchNonce,
    seedSha256: expectation.seedSha256,
    directiveSha256: 'd'.repeat(64),
    route,
    routeAttestations: [{ provider: route.provider, model: route.model, stop_reason: 'stop' }],
    stopReason: 'stop',
    turns: 3,
    toolCalls: 5,
    usage: { status: 'observed', usage: observedUsage },
    answerBlocks,
    spilledArtifacts: [],
  });
}

function expectTypedFailure(action: () => unknown, code: string, label: string): void {
  let failure: unknown;
  let threw = false;
  try {
    action();
  } catch (error) {
    threw = true;
    failure = error;
  }
  if (!threw) throw new Error(`expected failure: ${label}`);
  expect(failure, label).toBeInstanceOf(SubagentError);
  expect((failure as SubagentError).code, label).toBe(code);
}

describe('subagent result package', () => {
  it('round-trips a committed answer through verification', () => {
    const pkg = buildPackage(['first part of the answer', 'second part']);
    const serialized = serializeSubagentResultPackage(pkg);
    expect(serialized.endsWith('\n')).toBe(true);
    const verified = verifySubagentResultPackage(serialized, expectation);
    expect(verified.package.schema_version).toBe('pi-subagent.result.v1');
    expect(verified.package.turns).toBe(3);
    expect(verified.package.usage).toEqual({ status: 'observed', usage: observedUsage });
    expect(verified.answer).toBe('first part of the answersecond part');
    expect(verified.answerBytes.length).toBe(verified.package.answer.byte_length);
    expect(verified.package.answer.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects text that cannot round-trip through UTF-8', () => {
    const loneSurrogate = 'endangered \ud800 surrogate';
    let failure: unknown;
    try {
      assertWellFormedUtf8(loneSurrogate, 'subagent answer block 0');
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SubagentError);
    expect((failure as SubagentError).code).toBe('child_result_encoding_invalid');
  });

  it('rejects a foreign or stale package identity', () => {
    const pkg = buildPackage(['answer']);
    const serialized = serializeSubagentResultPackage(pkg);
    expectTypedFailure(
      () =>
        verifySubagentResultPackage(
          serialized.replace(expectation.launchNonce, 'x'.repeat(32)),
          expectation,
        ),
      'child_result_invalid',
      'wrong nonce',
    );
    expectTypedFailure(
      () =>
        verifySubagentResultPackage(
          serialized.replace(expectation.seedSha256, 'e'.repeat(64)),
          expectation,
        ),
      'seed_hash_mismatch',
      'wrong seed hash',
    );
  });

  it('rejects route drift, missing attestations, and attestation mismatch', () => {
    const drifted = buildPackage(['answer'], { provider: 'someone-else', model: 'other' });
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(drifted), expectation),
      'route_mismatch',
      'drifted route',
    );
    const noAttestations = buildPackage(['answer']);
    noAttestations.route_attestations = [];
    expectTypedFailure(
      () =>
        verifySubagentResultPackage(serializeSubagentResultPackage(noAttestations), expectation),
      'route_attestation_missing',
      'no attestations',
    );
    const foreignAttestation = buildPackage(['answer']);
    foreignAttestation.route_attestations = [
      { provider: 'someone-else', model: 'other', stop_reason: 'stop' },
    ];
    expectTypedFailure(
      () =>
        verifySubagentResultPackage(
          serializeSubagentResultPackage(foreignAttestation),
          expectation,
        ),
      'route_mismatch',
      'foreign attestation',
    );
  });

  it('rejects substituted, miscounted, and mislabeled answer bytes', () => {
    const substituted = buildPackage(['answer']);
    const substitutedBlock = substituted.answer.blocks[0];
    if (substitutedBlock === undefined) throw new Error('expected one answer block');
    substitutedBlock.data_base64 = Buffer.from('SUBSTITUTED', 'utf8').toString('base64');
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(substituted), expectation),
      'answer_hash_mismatch',
      'substituted block bytes',
    );
    const miscounted = buildPackage(['answer']);
    miscounted.answer.byte_length += 1;
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(miscounted), expectation),
      'answer_hash_mismatch',
      'miscounted aggregate length',
    );
    const relabeled = buildPackage(['answer']);
    relabeled.answer.sha256 = '0'.repeat(64);
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(relabeled), expectation),
      'answer_hash_mismatch',
      'relabeled aggregate hash',
    );
    const padded = buildPackage(['answer']);
    const paddedBlock = padded.answer.blocks[0];
    if (paddedBlock === undefined) throw new Error('expected one answer block');
    paddedBlock.data_base64 = `${paddedBlock.data_base64}==`;
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(padded), expectation),
      'child_result_invalid',
      'non-canonical base64 padding',
    );
  });

  it('rejects incomplete and malformed usage records', () => {
    const incomplete = buildPackage(['answer']);
    incomplete.usage = { status: 'unavailable' } as never;
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(incomplete), expectation),
      'child_result_invalid',
      'unavailable usage without reason',
    );
    const zeroCost = buildPackage(['answer']);
    zeroCost.usage = {
      status: 'observed',
      usage: { ...observedUsage, cost: { ...observedUsage.cost, total: -1 } },
    };
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(zeroCost), expectation),
      'child_result_invalid',
      'negative cost',
    );
  });

  it('rejects invalid spill receipts', () => {
    const spilled = buildPackage(['answer']);
    spilled.spilled_artifacts = [
      {
        schema_version: 'pi-subagent.receipt.v1',
        artifact: 'spill/x.bin',
        tool_name: 'read',
        tool_call_id: 'c1',
        turn_sequence: 1,
        source_call_index: 0,
        byte_length: 3,
        sha256: 'a'.repeat(64),
        content_format: 'single_text_utf8',
      },
    ];
    expect(() =>
      verifySubagentResultPackage(serializeSubagentResultPackage(spilled), expectation),
    ).not.toThrow();
    const badReceipt = buildPackage(['answer']);
    badReceipt.spilled_artifacts = [
      {
        schema_version: 'pi-subagent.receipt.v1',
        artifact: 'spill/x.bin',
        tool_name: 'read',
        tool_call_id: 'c1',
        turn_sequence: 1,
        source_call_index: 0,
        byte_length: 3,
        sha256: 'not-hex',
        content_format: 'single_text_utf8',
      },
    ];
    expectTypedFailure(
      () => verifySubagentResultPackage(serializeSubagentResultPackage(badReceipt), expectation),
      'child_result_invalid',
      'invalid receipt hash',
    );
  });
});
