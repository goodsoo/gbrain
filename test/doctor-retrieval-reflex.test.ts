/**
 * Doctor retrieval_reflex_health check (#1981, T8).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRetrievalReflexCheck } from '../src/commands/doctor.ts';

const origEnv = process.env.GBRAIN_RETRIEVAL_REFLEX;
afterEach(() => {
  if (origEnv === undefined) delete process.env.GBRAIN_RETRIEVAL_REFLEX;
  else process.env.GBRAIN_RETRIEVAL_REFLEX = origEnv;
});

describe('buildRetrievalReflexCheck', () => {
  test('disabled via env → warn, names the right check', () => {
    process.env.GBRAIN_RETRIEVAL_REFLEX = 'false';
    const c = buildRetrievalReflexCheck(null);
    expect(c.name).toBe('retrieval_reflex_health');
    expect(c.status).toBe('warn');
    expect(c.message).toContain('disabled');
    expect((c.details as any)?.enabled).toBe(false);
  });

  test('enabled → reports policy-skill install state in details', () => {
    process.env.GBRAIN_RETRIEVAL_REFLEX = 'true';
    const dir = mkdtempSync(join(tmpdir(), 'rr-doctor-'));
    mkdirSync(join(dir, 'retrieval-reflex'), { recursive: true });
    writeFileSync(join(dir, 'retrieval-reflex', 'SKILL.md'), '# stub\n');
    const c = buildRetrievalReflexCheck(dir);
    expect(c.name).toBe('retrieval_reflex_health');
    expect((c.details as any)?.enabled).toBe(true);
    expect((c.details as any)?.policy_skill_installed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('enabled, policy skill absent → message includes the install hint', () => {
    process.env.GBRAIN_RETRIEVAL_REFLEX = 'true';
    const dir = mkdtempSync(join(tmpdir(), 'rr-doctor-2-'));
    const c = buildRetrievalReflexCheck(dir);
    expect((c.details as any)?.policy_skill_installed).toBe(false);
    expect(c.message).toContain('gbrain integrations install retrieval-reflex');
    rmSync(dir, { recursive: true, force: true });
  });
});
