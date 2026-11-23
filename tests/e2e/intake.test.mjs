// Black-box tests of the order intake webhook on a running n8n instance.
// Run with scripts/test.sh. Every order gets a fresh idempotency key, email and phone,
// so the suite can be repeated; created orders use the @autotest.invalid domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = `${process.env.N8N_URL.replace(/\/$/, '')}/webhook/orders`;
const base = JSON.parse(readFileSync(new URL('../../test-payloads/valid-new.json', import.meta.url)));

const order = (overrides = {}) => ({
  ...base,
  idempotency_key: randomUUID(),
  email: `${randomUUID()}@autotest.invalid`,
  phone: `+49151${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
  ...overrides,
});

const post = async (body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// name -> [payload overrides, the only field expected in errors]
const invalid = {
  'unknown site token': [{ token: randomUUID() }, 'token'],
  'unknown product': [{ product_id: 'nope' }, 'product_id'],
  'filled honeypot': [{ terms: 'on' }, 'terms'],
  'missing idempotency key': [{ idempotency_key: '' }, 'idempotency_key'],
  'malformed email': [{ email: 'not-an-email' }, 'email'],
  'malformed phone': [{ phone: '123' }, 'phone'],
  'malformed iban': [{ iban: 'XX' }, 'iban'],
  'impossible birth date': [{ birth_date: '31.02.1990' }, 'birth_date'],
  'missing common field': [{ city: ' ' }, 'city'],
  'missing product-specific field': [{ id_number: '' }, 'id_number'],
};

for (const [name, [overrides, field]] of Object.entries(invalid)) {
  test(`rejects ${name}`, async () => {
    const { status, body } = await post(order(overrides));
    assert.equal(status, 422);
    assert.equal(body.status, 'error');
    assert.deepEqual(Object.keys(body.errors), [field]);
  });
}

const accepted = ({ status, body }) => {
  assert.equal(status, 200);
  assert.equal(body.status, 'success');
  assert.match(String(body.order_id), /^\d+$/);
  assert.equal(body.is_duplicate, false);
  return body.order_id;
};

test('accepts a new order', async () => {
  accepted(await post(order()));
});

test('accepts a product without the id document fields', async () => {
  accepted(await post(order({ product_id: 'dsl-100', birth_place: '', id_number: '', id_valid_until: '' })));
});

test('answers a blocked underage order like a normal one', async () => {
  accepted(await post(order({ birth_date: '01.01.2015' })));
});

test('returns the same order for a repeated idempotency key', async () => {
  const payload = order();
  const first = accepted(await post(payload));
  const second = accepted(await post(payload));
  assert.equal(second, first);
});
