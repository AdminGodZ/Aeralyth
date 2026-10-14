import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { nextFixtureChanges } from "./fixture-stream.mjs";

// Local Docker fixture only. Never use this script against a deployed database.
const origin = new URL(
  process.env.AERALYTH_PERF_URL ?? "http://127.0.0.1:8080/health",
).origin;
const secondOrigin = new URL(
  process.env.AERALYTH_REALTIME_SECOND_ORIGIN ?? origin,
).origin;
for (const value of [origin, secondOrigin]) {
  assert.equal(
    new URL(value).hostname,
    "127.0.0.1",
    "realtime smoke test requires loopback APIs",
  );
}
const prefix = `rt${randomBytes(8).toString("hex")}`;
const owner = `${prefix}a`;
const other = `${prefix}b`;
const token = randomBytes(32).toString("hex");
const otherToken = randomBytes(32).toString("hex");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sql = (query) =>
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-XqAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "aeralyth",
      "-d",
      "aeralyth",
    ],
    { input: query, encoding: "utf8" },
  ).trim();
const streams = [];
const headers = (value) => ({ Cookie: `aeralyth_session=${value}` });
async function sync(value, cursor, extraHeaders = {}) {
  return fetch(
    `${origin}/api/events/sync${cursor === undefined ? "" : `?cursor=${cursor}`}`,
    {
      headers: { ...headers(value), ...extraHeaders },
      signal: AbortSignal.timeout(5000),
    },
  );
}
async function openStream(value, cursor, base = origin, extraHeaders = {}) {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/api/events${cursor === undefined ? "" : `?cursor=${cursor}`}`,
    {
      headers: { ...headers(value), ...extraHeaders },
      signal: controller.signal,
    },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(
    response.headers.get("content-encoding"),
    null,
    "SSE must not be compressed or buffered",
  );
  assert.match(response.headers.get("cache-control"), /no-store/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const stream = {
    close: () => controller.abort(),
    async next(deadline = performance.now() + 5000) {
      const remainingMs = deadline - performance.now();
      assert.ok(remainingMs > 0, "event deadline exceeded");
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      try {
        while (!buffer.includes("\n\n")) {
          const chunk = await reader.read();
          assert.equal(
            chunk.done,
            false,
            "event stream ended before the expected event",
          );
          buffer += decoder.decode(chunk.value, { stream: true });
        }
        const end = buffer.indexOf("\n\n");
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return Object.fromEntries(
          frame
            .split("\n")
            .filter((line) => line.includes(": "))
            .map((line) => {
              const separator = line.indexOf(": ");
              return [line.slice(0, separator), line.slice(separator + 2)];
            }),
        );
      } finally {
        clearTimeout(timeout);
      }
    },
    async expectClosed(deadline) {
      assert.equal(buffer, "", "revoked stream must not queue more events");
      const remainingMs = deadline - performance.now();
      assert.ok(remainingMs > 0, "stream closure deadline exceeded");
      const timeout = setTimeout(() => controller.abort(), remainingMs);
      try {
        assert.equal(
          (await reader.read()).done,
          true,
          "revoked stream must end after session-expired",
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  streams.push(stream);
  return stream;
}

try {
  sql(`INSERT INTO users (id, username, password_hash, role) VALUES ('${owner}', '${owner}', 'unused-test-password', 'user'), ('${other}', '${other}', 'unused-test-password', 'user');
    INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES
    ('${owner}', '${owner}', decode('${hash(token)}', 'hex'), '${prefix}', now() + interval '1 hour'),
    ('${other}', '${other}', decode('${hash(otherToken)}', 'hex'), '${prefix}', now() + interval '1 hour');
    SELECT realtime_dispatch();`);
  assert.equal((await fetch(`${origin}/api/events`)).status, 401);
  assert.equal((await fetch(`${origin}/api/events/sync`)).status, 401);
  assert.equal((await sync(token, "invalid")).status, 400);
  assert.equal(
    (await sync(token, undefined, { "Sec-Fetch-Site": "cross-site" })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/events?cursor=invalid`, {
        headers: headers(token),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/events`, {
        headers: { ...headers(token), "Sec-Fetch-Site": "cross-site" },
      })
    ).status,
    403,
  );

  const first = await openStream(token);
  const second = await openStream(token, undefined, secondOrigin);
  assert.equal((await first.next()).event, "reset");
  const initial = await second.next();
  assert.equal(initial.event, "reset");
  const start = performance.now();
  const deliveryDeadline = start + 5000;
  sql(`UPDATE users SET display_name = 'Realtime test' WHERE id = '${owner}';`);
  for (const stream of [first, second]) {
    const event = await nextFixtureChanges(stream, deliveryDeadline);
    assert.deepEqual(JSON.parse(event.data), [
      { scope: "profile", folderIds: [] },
    ]);
  }
  const deliveryMs = Math.round(performance.now() - start);

  const catchUp = await sync(token, initial.id);
  assert.match(catchUp.headers.get("cache-control"), /no-store/);
  const caughtUp = await catchUp.json();
  assert.equal(caughtUp.reset, false);
  assert.equal(typeof caughtUp.cursor, "string");
  assert.deepEqual(caughtUp.changes, [{ scope: "profile", folderIds: [] }]);
  assert.deepEqual(
    await (await sync(token, caughtUp.cursor)).json(),
    {
      cursor: caughtUp.cursor,
      reset: false,
      changes: [],
    },
    "unchanged catch-up must not invalidate the page",
  );
  assert.deepEqual(
    (await (await sync(otherToken, initial.id)).json()).changes,
    [],
    "catch-up must not expose another account's changes",
  );
  assert.equal(
    (await (await sync(token, "9223372036854775807")).json()).reset,
    true,
  );
  assert.equal((await (await sync(token)).json()).reset, true);

  const isolated = await openStream(otherToken, initial.id);
  assert.equal(
    (await isolated.next()).event,
    "checkpoint",
    "another account must not receive the owner's changes",
  );
  isolated.close();
  first.close();
  second.close();
  const replay = await openStream(token, initial.id, secondOrigin);
  assert.equal(
    (await nextFixtureChanges(replay)).event,
    "changes",
    "reconnect must replay a missed change",
  );
  replay.close();
  const future = await openStream(token, "9223372036854775807");
  const reset = await future.next();
  assert.equal(reset.event, "reset");
  future.close();
  const precedence = await openStream(token, "invalid", origin, {
    "Last-Event-ID": reset.id,
  });
  assert.equal(
    (await precedence.next()).event,
    "checkpoint",
    "native reconnect cursor takes precedence",
  );
  precedence.close();

  // More notifications than the previous reader channel could hold. The
  // connection driver must keep polling while its dispatcher query completes.
  const burst = await openStream(token, reset.id, secondOrigin);
  await burst.next();
  sql(`BEGIN; SELECT realtime_enqueue('${prefix}fanout' || n, 'files') FROM generate_series(1, 512) n;
    SELECT realtime_enqueue('${owner}', 'files', ARRAY['']); COMMIT;`);
  const burstEvent = await nextFixtureChanges(burst);
  assert.deepEqual(JSON.parse(burstEvent.data), [
    { scope: "files", folderIds: [""] },
  ]);
  burst.close();
  assert.equal(
    sql(
      `SELECT count(*) FROM realtime_outbox WHERE user_id LIKE '${prefix}%';`,
    ),
    "0",
  );

  const revoked = await openStream(otherToken);
  await revoked.next();
  const revocationStart = performance.now();
  const revocationDeadline = revocationStart + 5000;
  sql(`DELETE FROM sessions WHERE id = '${other}';`);
  assert.equal(
    (
      await fetch(`${origin}/api/events`, {
        headers: headers(otherToken),
        signal: AbortSignal.timeout(5000),
      })
    ).status,
    401,
  );
  assert.equal((await sync(otherToken)).status, 401);
  // Deleting the session also emits a security invalidation. It can arrive
  // before the shared authorization batch, whose existing lease is five seconds.
  // Keep one absolute deadline across frames, then verify actual server closure.
  const revocationEvents = [];
  for (;;) {
    const frame = await revoked.next(revocationDeadline);
    revocationEvents.push(frame.event);
    if (frame.event === "session-expired") break;
    if (frame.event === "changes") {
      assert.deepEqual(JSON.parse(frame.data), [
        { scope: "security", folderIds: [] },
      ]);
    } else {
      assert.equal(frame.event, "checkpoint");
    }
  }
  await revoked.expectClosed(revocationDeadline);
  const revocationMs = Math.round(performance.now() - revocationStart);
  console.log(
    JSON.stringify({
      passed: true,
      deliveryMs,
      revocationMs,
      revocationEvents,
      replicas: origin !== secondOrigin,
      checks: [
        "authenticated SSE",
        "account isolation",
        "replay",
        "cursor reset",
        "Last-Event-ID",
        "513-recipient burst",
        "session revocation",
        "unbuffered headers",
        "catch-up replay, unchanged cursor, isolation, reset and revocation",
      ],
    }),
  );
} finally {
  for (const stream of streams) stream.close();
  sql(`DELETE FROM users WHERE id IN ('${owner}', '${other}');
    DELETE FROM realtime_outbox WHERE user_id LIKE '${prefix}%';
    DELETE FROM realtime_events WHERE user_id LIKE '${prefix}%';`);
}
