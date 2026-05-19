/**
 * v0.36.1.x #1100: PGLite + `gbrain apply-migrations` chain spawn test.
 *
 * Spawns `gbrain init --pglite` followed by `gbrain apply-migrations --yes
 * --non-interactive` against a fresh tmpdir, asserts the full migration
 * chain walks to head without wedging on the v0.11.0 Minions phase A
 * subprocess deadlock.
 *
 * Pre-fix, this exact sequence hit `GBrain: Timed out waiting for PGLite
 * lock` because:
 *   1. apply-migrations pre-flight schema-version probe held the
 *      single-writer lock briefly and raced the v0.11.0 subprocess.
 *   2. v0.11.0 phase A spawned `gbrain init --migrate-only` as a child;
 *      the child inherited HOME and tried to acquire the same lock.
 *
 * The fix routes phase A in-process for PGLite and skips the pre-flight
 * probe on PGLite (the warning is non-essential there). No DATABASE_URL
 * needed; runs in standard unit CI.
 *
 * Serial because it mutates HOME via env passed to the subprocess and
 * mkdtemp+rmSync is cheap but per-test.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

async function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs: number = 90_000,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', `${REPO}/src/cli.ts`, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch { /* already dead */ }
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(killer);
  }
}

function makeFreshBrain(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-pglite-spawn-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  // Seed the canonical fresh-install config shape directly so the test
  // doesn't depend on `gbrain init --pglite`'s interactive prompts.
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({
      engine: 'pglite',
      database_path: join(home, '.gbrain', 'brain.pglite'),
      embedding_dimensions: 1536,
    }) + '\n',
  );
  return {
    home,
    cleanup: () => {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

describe('apply-migrations on fresh PGLite (v0.36.1.x #1100)', () => {
  test('apply-migrations --yes walks the full migration chain to head', async () => {
    const { home, cleanup } = makeFreshBrain();
    try {
      const env = { HOME: home, GBRAIN_HOME: home };

      // First, prove migrate-only works (the phase A subprocess target on
      // pre-fix Postgres installs — on PGLite it should also work but
      // pre-fix the parent + child raced for the lock).
      const init = await runCli(['init', '--migrate-only'], env, 90_000);
      expect(init.exitCode).toBe(0);
      expect(init.stdout + init.stderr).toMatch(/Schema up to date|migration\(s\) applied/);

      // Then run the orchestrator chain. Pre-fix this wedged on v0.11.0
      // with "GBrain: Timed out waiting for PGLite lock" and dead-lettered.
      const apply = await runCli(
        ['apply-migrations', '--yes', '--non-interactive'],
        env,
        180_000,
      );
      expect(apply.exitCode).toBe(0);
      const out = apply.stdout + apply.stderr;
      // No lock timeout (the original symptom)
      expect(out).not.toMatch(/Timed out waiting for PGLite lock/);
      // No fast-failing subprocess on phase A
      expect(out).not.toMatch(/Phase A \(schema\) failed/);
      // The brain repo is intact
      expect(existsSync(join(home, '.gbrain', 'brain.pglite'))).toBe(true);
    } finally {
      cleanup();
    }
  }, 240_000);

  test('re-running apply-migrations on an up-to-date brain reports clean exit', async () => {
    const { home, cleanup } = makeFreshBrain();
    try {
      const env = { HOME: home, GBRAIN_HOME: home };
      // Initial migrate
      const first = await runCli(['init', '--migrate-only'], env, 90_000);
      expect(first.exitCode).toBe(0);
      // Apply-migrations (should be idempotent — no work to do on PGLite-only fresh init)
      const apply = await runCli(['apply-migrations', '--yes', '--non-interactive'], env, 120_000);
      expect(apply.exitCode).toBe(0);
      // Re-run; this is the v0.36.1.x #1062 exit-code path: "All migrations
      // up to date" must exit 0, not fall through to implicit non-zero.
      const second = await runCli(['apply-migrations', '--yes', '--non-interactive'], env, 60_000);
      expect(second.exitCode).toBe(0);
      const out = second.stdout + second.stderr;
      expect(out).toMatch(/All migrations up to date|All up to date/);
    } finally {
      cleanup();
    }
  }, 240_000);

  test('apply-migrations --list exits 0 on PGLite with no work', async () => {
    const { home, cleanup } = makeFreshBrain();
    try {
      const env = { HOME: home, GBRAIN_HOME: home };
      // Migrate first so the list shows applied entries
      await runCli(['init', '--migrate-only'], env, 90_000);
      await runCli(['apply-migrations', '--yes', '--non-interactive'], env, 90_000);
      // List path — must exit 0 (the v0.36.1.x #1062 fix)
      const list = await runCli(['apply-migrations', '--list'], env, 60_000);
      expect(list.exitCode).toBe(0);
      expect(list.stdout + list.stderr).toMatch(/applied|pending|migration/i);
    } finally {
      cleanup();
    }
  }, 180_000);
});
