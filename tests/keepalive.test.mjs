import test from 'node:test';
import assert from 'node:assert/strict';
import { setSupabaseClientForTesting } from '../api/v1/acp/_supabase.ts';
import keepaliveHandler from '../api/v1/keepalive.ts';

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      this.ended = true;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    }
  };
  return res;
}

test('keepalive fails closed with 503 when supabase client is unconfigured', async (t) => {
  const prevUrl = process.env.SUPABASE_URL;
  const prevPublicUrl = process.env.PUBLIC_SUPABASE_URL;
  const prevServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const prevCronSecret = process.env.CRON_SECRET;

  delete process.env.SUPABASE_URL;
  delete process.env.PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.CRON_SECRET;
  setSupabaseClientForTesting(null);

  t.after(() => {
    if (prevUrl !== undefined) process.env.SUPABASE_URL = prevUrl;
    if (prevPublicUrl !== undefined) process.env.PUBLIC_SUPABASE_URL = prevPublicUrl;
    if (prevServiceKey !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = prevServiceKey;
    if (prevCronSecret !== undefined) process.env.CRON_SECRET = prevCronSecret;
    setSupabaseClientForTesting(null);
  });

  const res = createMockRes();
  await keepaliveHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'SUPABASE_NOT_CONFIGURED');
});

test('keepalive returns 200 when lightweight agent_tasks probe succeeds', async (t) => {
  setSupabaseClientForTesting({
    from(table) {
      assert.equal(table, 'agent_tasks');
      return {
        select(cols, opts) {
          assert.equal(cols, 'id');
          assert.deepEqual(opts, { count: 'exact', head: true });
          return Promise.resolve({ error: null });
        }
      };
    }
  });
  t.after(() => setSupabaseClientForTesting(null));

  const res = createMockRes();
  await keepaliveHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.database_alive, true);
});

test('keepalive fails closed with 503 when supabase query returns error', async (t) => {
  setSupabaseClientForTesting({
    from() {
      return {
        select() {
          return Promise.resolve({ error: { code: 'PGRST000', message: 'connection refused' } });
        }
      };
    }
  });
  t.after(() => setSupabaseClientForTesting(null));

  const res = createMockRes();
  await keepaliveHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.database_alive, false);
  assert.equal(res.body.error, 'SUPABASE_PROBE_FAILED');
});

test('keepalive enforces CRON_SECRET when set and rejects non-GET methods', async (t) => {
  const prevCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-cron-secret';
  setSupabaseClientForTesting({
    from() {
      return {
        select() {
          return Promise.resolve({ error: null });
        }
      };
    }
  });
  t.after(() => {
    if (prevCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevCronSecret;
    setSupabaseClientForTesting(null);
  });

  const postRes = createMockRes();
  await keepaliveHandler({ method: 'POST', headers: {} }, postRes);
  assert.equal(postRes.statusCode, 405);

  const unauthRes = createMockRes();
  await keepaliveHandler({ method: 'GET', headers: {} }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  const authRes = createMockRes();
  await keepaliveHandler(
    { method: 'GET', headers: { authorization: 'Bearer test-cron-secret' } },
    authRes
  );
  assert.equal(authRes.statusCode, 200);
  assert.equal(authRes.body.ok, true);
});
