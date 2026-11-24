// End-to-end tests of the whole pipeline on the local test stand (scripts/stand.sh up).
// They read the database, the Mailpit inbox and the requests the provider stub received,
// so they are skipped when the suite runs against a real instance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const { N8N_URL, STUB_URL, MAILPIT_URL } = process.env;
const skip = STUB_URL ? false : 'needs the test stand: scripts/stand.sh test';
const base = JSON.parse(readFileSync(new URL('../../test-payloads/valid-new.json', import.meta.url)));
const DUPLICATE_STAGE = '6503850198'; // products.hubspot_duplicate_stage in db/seed.sql

const customer = (overrides = {}) => ({
  ...base,
  email: `autotest-${randomUUID()}@example.com`,
  phone: `+49151${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
  ...overrides,
});

const json = async (url, options) => (await fetch(url, options)).json();
const post = (url, body) =>
  json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const submit = (payload) => post(`${N8N_URL}/webhook/orders`, { ...payload, idempotency_key: randomUUID() });

// Rows of a query as objects. Values are interpolated: test data only.
const sql = (query) => {
  const out = execFileSync(
    'docker',
    ['compose', '-f', 'compose.test.yaml', 'exec', '-T', 'postgres', 'psql', '-U', 'n8n', '-d', 'n8n', '-At',
      '-c', `SELECT coalesce(json_agg(t), '[]') FROM (${query}) t`],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
};
const run = (statement) => {
  execFileSync('docker', ['compose', '-f', 'compose.test.yaml', 'exec', '-T', 'postgres', 'psql', '-U', 'n8n',
    '-d', 'n8n', '-qc', statement]);
};
const verify = (email) => run(`INSERT INTO leadgen.verified_emails (email) VALUES ('${email}')`);
// One scheduler pass; the webhook answers when every batch has been processed.
const schedulerPass = async () => {
  const res = await fetch(`${N8N_URL}/webhook/scheduler/run`, { method: 'POST', headers: { 'X-Scheduler-Key': 'test' } });
  assert.equal(res.status, 200);
};
// What a crashed or failed run leaves behind once its lock has gone stale.
const STALE_LOCK = "locked_at = now() - interval '11 minutes'";

// Processing runs after the webhook has answered, so results are polled for.
const eventually = async (probe, what) => {
  for (let i = 0; i < 60; i++) {
    const result = await probe();
    if (result) return result;
    await sleep(250);
  }
  assert.fail(`timed out waiting for ${what}`);
};

const order = (id) => sql(`SELECT * FROM leadgen.orders WHERE id = ${id}`)[0];
const completed = (id) => eventually(() => order(id).completed_at && order(id), `order ${id} to complete`);
const steps = (id) =>
  sql(`SELECT type FROM leadgen.provider_records WHERE order_id = ${id} ORDER BY type`).map((r) => r.type);
const stubRequests = (path) => json(`${STUB_URL}/__requests`).then((all) => all.filter((r) => path.test(r.path)));
const dealOf = async (id) =>
  (await stubRequests(/\/objects\/deals$/)).find((r) => r.body.properties.order_number === String(id))?.body;
const mail = (to, subject) =>
  eventually(async () => {
    const { messages } = await json(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const found = messages.find((m) => subject.test(m.Subject));
    return found && json(`${MAILPIT_URL}/api/v1/message/${found.ID}`);
  }, `mail to ${to}`);

test('processes an order from a verified address through every step', { skip }, async () => {
  const payload = customer();
  verify(payload.email);
  const { order_id: id } = await submit(payload);

  const row = await completed(id);
  assert.equal(row.duplicate, 0);
  assert.equal(row.next_attempt_at, null);
  assert.deepEqual(steps(id), ['email_order_received', 'hubspot_contact', 'hubspot_deal', 'meta_purchase']);

  const deal = await dealOf(id);
  assert.equal(deal.properties.order_email, payload.email);
  assert.equal(deal.properties.dealstage, 'appointmentscheduled');
  assert.equal(deal.properties.id_valid_until, '2030-01-01');
  assert.ok(deal.associations[0].to.id, 'deal is attached to the contact');

  const event = (await stubRequests(/\/events$/)).find((r) => r.body.data[0].event_id === String(id));
  assert.equal(event.body.data[0].user_data.em, createHash('sha256').update(payload.email).digest('hex'));
  await mail(payload.email, /./);
});

test('holds an unverified order until the link in the email is clicked', { skip }, async () => {
  const payload = customer();
  const { order_id: id } = await submit(payload);
  assert.equal(order(id).completed_at, null);
  assert.deepEqual(steps(id), ['email_verification']);

  const message = await mail(payload.email, /./);
  const [link] = message.Text.match(/http\S+verify-email\?token=[0-9a-f-]{36}/);
  const click = await fetch(link, { redirect: 'manual' });
  assert.equal(click.status, 307);
  assert.equal(click.headers.get('location'), 'https://example.com/?email-verified');

  await completed(id);
  assert.ok((await dealOf(id)), 'deal created after the click');
});

test('rejects a second order while the previous deal is recent', { skip }, async () => {
  const payload = customer();
  verify(payload.email);
  await completed((await submit(payload)).order_id);

  const second = await submit(payload);
  assert.equal(second.is_duplicate, true);
  assert.equal(order(second.order_id).duplicate, 2);
  assert.equal(await dealOf(second.order_id), undefined);
});

test('sends an order after an old deal to the duplicate stage', { skip }, async () => {
  const payload = customer();
  verify(payload.email);
  const contact = await post(`${STUB_URL}/crm/v3/objects/contacts`, { properties: { email: payload.email } });
  await post(`${STUB_URL}/crm/v3/objects/deals`, {
    properties: { createdate: new Date(Date.now() - 60 * 86400000).toISOString() },
    associations: [{ to: { id: contact.id } }],
  });

  const { order_id: id, is_duplicate } = await submit(payload);
  assert.equal(is_duplicate, false);
  assert.equal((await completed(id)).duplicate, 1);
  const deal = await dealOf(id);
  assert.equal(deal.properties.dealstage, DUPLICATE_STAGE);
  assert.equal(deal.associations[0].to.id, contact.id, 'existing contact is reused');
});

test('schedules a retry and alerts when a provider rejects the order', { skip }, async () => {
  const payload = customer({ email: `autotest-${randomUUID()}@autotest.invalid` });
  verify(payload.email);
  const { order_id: id, status } = await submit(payload);
  assert.equal(status, 'success', 'the landing page is not told about provider failures');

  const alert = await eventually(
    async () => (await stubRequests(/sendMessage$/)).find((r) => /Node: HubSpot/i.test(r.body.text)),
    'the error alert',
  );
  assert.match(alert.body.text, /Order processing/);

  const row = order(id);
  assert.equal(row.completed_at, null);
  assert.equal(row.attempts, 1);
  assert.ok(new Date(row.next_attempt_at) > new Date(Date.now() + 10 * 60000), 'next attempt is about 15 minutes away');
  assert.deepEqual(steps(id), []);
});

test('refuses a scheduler pass without the key', { skip }, async () => {
  const res = await fetch(`${N8N_URL}/webhook/scheduler/run`, { method: 'POST' });
  assert.equal(res.status, 403);
});

test('processes an unverified order when its waiting time is over', { skip }, async () => {
  const { order_id: id } = await submit(customer());
  await schedulerPass();
  assert.equal(order(id).completed_at, null, 'not due yet');

  run(`UPDATE leadgen.orders SET next_attempt_at = now() WHERE id = ${id}`);
  await schedulerPass();
  assert.ok(order(id).completed_at);
  assert.ok(await dealOf(id));
});

test('retries a failed order and reports it once when attempts run out', { skip }, async () => {
  const payload = customer({ email: `autotest-${randomUUID()}@autotest.invalid` });
  verify(payload.email);
  const { order_id: id } = await submit(payload);
  await eventually(() => order(id).attempts === 1, 'the first attempt');

  run(`UPDATE leadgen.orders SET next_attempt_at = now(), ${STALE_LOCK} WHERE id = ${id}`);
  await schedulerPass();
  const retried = order(id);
  assert.equal(retried.attempts, 2);
  assert.ok(new Date(retried.next_attempt_at) > new Date(Date.now() + 50 * 60000), 'second backoff step is an hour');
  assert.equal(retried.failed_at, null);

  // Out of attempts: nothing scheduled and the last lock is stale.
  run(`UPDATE leadgen.orders SET next_attempt_at = NULL, ${STALE_LOCK} WHERE id = ${id}`);
  await schedulerPass();
  await schedulerPass();
  assert.ok(order(id).failed_at);
  const alerts = (await stubRequests(/sendMessage$/)).filter((r) => r.body.text.startsWith(`Order ${id} failed`));
  assert.equal(alerts.length, 1, 'reported once across two passes');
  assert.equal(order(id).attempts, 2, 'no further attempts');
});

test('spaces out the orders of one customer so the second is caught as a duplicate', { skip }, async () => {
  const payload = customer();
  const first = (await submit(payload)).order_id;
  const second = (await submit(payload)).order_id;
  run(`UPDATE leadgen.orders SET next_attempt_at = now() WHERE id IN (${first}, ${second})`);

  await schedulerPass();
  assert.ok(order(first).completed_at, 'the oldest order goes first');
  assert.equal(order(second).attempts, 0, 'the next one waits while the first deal may not be searchable');

  run(`UPDATE leadgen.orders SET completed_at = now() - interval '2 minutes' WHERE id = ${first}`);
  await schedulerPass();
  assert.equal(order(second).duplicate, 2);
  assert.equal(await dealOf(second), undefined);
});

test('does not start an order while another one of the customer is in progress', { skip }, async () => {
  const payload = customer();
  const first = (await submit(payload)).order_id; // unverified, waits for the click
  run(`UPDATE leadgen.orders SET locked_at = now() WHERE id = ${first}`); // as if it were being processed
  verify(payload.email);

  const second = (await submit(payload)).order_id; // verified address: intake starts processing at once
  await sleep(1500);
  assert.equal(order(second).attempts, 0, 'the claim is refused');

  run(`UPDATE leadgen.orders SET locked_at = NULL WHERE id = ${first}`);
  await schedulerPass();
  assert.ok(order(second).completed_at, 'the scheduler picks the order up later');
});

test('keeps the other steps going when one provider fails and retries only the failed one', { skip }, async () => {
  const payload = customer({ original_url: 'https://landing.example/order?fbclid=meta-fail' }); // the stub rejects this event until healed
  verify(payload.email);
  const { order_id: id } = await submit(payload);

  const alert = await eventually(
    async () => (await stubRequests(/sendMessage$/)).find((r) => r.body.text.includes('Steps failed: Meta event')),
    'the error alert',
  );
  assert.match(alert.body.text, /Order processing/);
  assert.deepEqual(steps(id), ['email_order_received', 'hubspot_contact', 'hubspot_deal']);
  assert.equal(order(id).completed_at, null);

  await post(`${STUB_URL}/__heal`, { event_id: String(id) });
  run(`UPDATE leadgen.orders SET next_attempt_at = now(), ${STALE_LOCK} WHERE id = ${id}`);
  await schedulerPass();
  assert.ok(order(id).completed_at);
  assert.ok(steps(id).includes('meta_purchase'));
  const { messages } = await json(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${payload.email}`)}`);
  assert.equal(messages.length, 1, 'the email is not sent again');
  assert.equal((await stubRequests(/\/objects\/deals$/)).filter((r) => r.body.properties.order_number === String(id)).length, 1);
});
