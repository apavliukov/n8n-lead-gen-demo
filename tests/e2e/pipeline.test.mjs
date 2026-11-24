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
const verify = (email) => {
  execFileSync('docker', ['compose', '-f', 'compose.test.yaml', 'exec', '-T', 'postgres', 'psql', '-U', 'n8n',
    '-d', 'n8n', '-qc', `INSERT INTO leadgen.verified_emails (email) VALUES ('${email}')`]);
};

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
    async () => (await stubRequests(/sendMessage$/)).find((r) => r.body.text.includes('Create contact')),
    'the error alert',
  );
  assert.match(alert.body.text, /Order processing/);

  const row = order(id);
  assert.equal(row.completed_at, null);
  assert.equal(row.attempts, 1);
  assert.ok(new Date(row.next_attempt_at) > new Date(Date.now() + 10 * 60000), 'next attempt is about 15 minutes away');
  assert.deepEqual(steps(id), []);
});
