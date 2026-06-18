/**
 * Federated read grant for stdio MCP (`GBRAIN_ALLOWED_SOURCES`).
 *
 * stdio MCP has no per-token OAuth identity, so without an explicit grant a
 * multi-source brain's read ops fall back to the single scalar `sourceId` and
 * a bare `query`/`search`/`list_pages` returns nothing from the other sources.
 *
 * This pins the fix: `GBRAIN_ALLOWED_SOURCES` parses into a grant, dispatch
 * synthesizes a local AuthInfo carrying it, and source-scoped read ops then
 * span every listed source. Back-compat: no grant → scalar `sourceId` path
 * unchanged.
 *
 * Pins:
 *   - parseAllowedSourcesEnv: comma/whitespace split, trim, dedup, blank→undefined
 *   - buildOperationContext: synthesizes local auth from allowedSources;
 *     explicit opts.auth wins; no grant → no auth (back-compat)
 *   - synthetic auth omits run_protected_onboard (no scope regression)
 *   - E2E via dispatchToolCall(list_pages): grant spans both sources; scalar
 *     sourceId alone sees only its own source.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildOperationContext, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { parseAllowedSourcesEnv } from '../src/mcp/server.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('parseAllowedSourcesEnv', () => {
  test('undefined / blank → undefined (back-compat)', () => {
    expect(parseAllowedSourcesEnv(undefined)).toBeUndefined();
    expect(parseAllowedSourcesEnv('')).toBeUndefined();
    expect(parseAllowedSourcesEnv('   ')).toBeUndefined();
    expect(parseAllowedSourcesEnv(' , , ')).toBeUndefined();
  });

  test('comma-separated, trimmed, deduped', () => {
    expect(parseAllowedSourcesEnv('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseAllowedSourcesEnv(' a , b ,c ')).toEqual(['a', 'b', 'c']);
    expect(parseAllowedSourcesEnv('a,a,b')).toEqual(['a', 'b']);
  });

  test('whitespace-separated also accepted', () => {
    expect(parseAllowedSourcesEnv('a b\tc')).toEqual(['a', 'b', 'c']);
    expect(parseAllowedSourcesEnv('a, b\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('buildOperationContext synthesizes local federation auth', () => {
  test('allowedSources → synthetic local auth carrying the grant', () => {
    const ctx = buildOperationContext(engine, {}, { allowedSources: ['phai-studio', 'phact-studio'] });
    expect(ctx.auth?.allowedSources).toEqual(['phai-studio', 'phact-studio']);
    // local identity, NOT an OAuth client (whoami reports the token path)
    expect(ctx.auth?.clientId.startsWith('gbrain_cl_')).toBe(false);
    // full posture but NO protected-onboard scope (no regression vs auth:undefined)
    expect(ctx.auth?.scopes).not.toContain('run_protected_onboard');
  });

  test('no grant → no synthetic auth (back-compat scalar path)', () => {
    expect(buildOperationContext(engine, {}, {}).auth).toBeUndefined();
    expect(buildOperationContext(engine, {}, { allowedSources: [] }).auth).toBeUndefined();
  });

  test('explicit opts.auth wins over synthesized grant', () => {
    const real = { token: 't', clientId: 'gbrain_cl_real', scopes: ['read'], allowedSources: ['only-this'] };
    const ctx = buildOperationContext(engine, {}, { auth: real, allowedSources: ['ignored'] });
    expect(ctx.auth).toBe(real);
  });
});

describe('E2E: dispatchToolCall(list_pages) federation', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    await engine.putPage('notes/a', {
      type: 'note', title: 'A in default', compiled_truth: 'alpha', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.putPage('notes/b', {
      type: 'note', title: 'B in src-b', compiled_truth: 'beta', timeline: '', frontmatter: {},
    }, { sourceId: 'src-b' });
  });

  const listTitles = async (opts: Parameters<typeof dispatchToolCall>[3]) => {
    const res = await dispatchToolCall(engine, 'list_pages', {}, opts);
    expect(res.isError).toBeFalsy();
    const pages = JSON.parse(res.content[0].text) as Array<{ title: string }>;
    return pages.map((p) => p.title).sort();
  };

  test('grant spanning both sources returns pages from both', async () => {
    const titles = await listTitles({
      remote: true,
      sourceId: 'default',
      allowedSources: ['default', 'src-b'],
    });
    expect(titles).toEqual(['A in default', 'B in src-b']);
  });

  test('scalar sourceId alone (no grant) sees only its own source', async () => {
    const titles = await listTitles({ remote: true, sourceId: 'default' });
    expect(titles).toEqual(['A in default']);
  });
});
