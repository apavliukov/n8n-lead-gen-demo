// Unit tests of the Code nodes, taken straight from the exported workflows and run without n8n.
// Other nodes are replaced by canned outputs, e.g. a HubSpot search response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Runs the code of one Code node. `nodes` maps a node name to its fake output json;
// a node missing from the map counts as not executed.
const run = (workflow, node, nodes, input = {}) => {
  const file = new URL(`../../workflows/${workflow}.json`, import.meta.url);
  const { jsCode } = JSON.parse(readFileSync(file)).nodes.find((n) => n.name === node).parameters;
  const $ = (name) => ({ isExecuted: name in nodes, first: () => ({ json: nodes[name] }) });
  const $input = { first: () => ({ json: input }) };
  return new Function('$', '$input', jsCode)($, $input)[0].json;
};

const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString();

const duplicateCheck = ({ contacts = [], deals }) => run('duplicate-check', 'Result', {
  'When Executed by Another Workflow': { email: 'max@example.com', phone: '+49151000', duplicate_days: 30 },
  'Find contact': { total: contacts.length, results: contacts },
  ...(deals && { 'Find latest deal': { results: deals } }),
});
const contact = (id, email) => ({ id, properties: { email } });
const deal = (id, days) => ({ id, properties: { createdate: daysAgo(days) } });

// name -> [canned HubSpot responses, expected duplicate kind: 0 none, 1 good, 2 bad]
const duplicates = {
  'no contact': [{}, 0],
  'contact without deals': [{ contacts: [contact('1', 'max@example.com')], deals: [] }, 0],
  'deal older than the threshold': [{ contacts: [contact('1', 'max@example.com')], deals: [deal('9', 31)] }, 1],
  'deal younger than the threshold': [{ contacts: [contact('1', 'max@example.com')], deals: [deal('9', 29)] }, 2],
};

for (const [name, [responses, expected]] of Object.entries(duplicates)) {
  test(`duplicate check: ${name}`, () => {
    const result = duplicateCheck(responses);
    assert.equal(result.duplicate, expected);
    assert.equal(result.is_bad_duplicate, expected === 2);
    assert.equal(result.is_good_duplicate, expected === 1);
  });
}

test('duplicate check: prefers the contact that owns the order email', () => {
  const result = duplicateCheck({ contacts: [contact('1', 'other@example.com'), contact('2', 'Max@Example.com')], deals: [] });
  assert.equal(result.contact_id, '2');
  assert.equal(result.contact_matched_by_email, true);
});

test('duplicate check: a phone-only match is not an email match', () => {
  const result = duplicateCheck({ contacts: [contact('1', 'other@example.com')], deals: [] });
  assert.equal(result.contact_id, '1');
  assert.equal(result.contact_matched_by_email, false);
});

const payload = JSON.parse(readFileSync(new URL('../../test-payloads/valid-new.json', import.meta.url)));
const validate = (body, row = { site_id: 1, product_id: 1, required_fields: ['birth_place', 'id_number', 'id_valid_until'] }) =>
  run('order-intake', 'Validate', { Webhook: { body, headers: { 'x-real-ip': '198.51.100.1', 'user-agent': 'header-agent' } } }, row);

test('validate: normalizes a valid order', () => {
  const { valid, order } = validate({ ...payload, email: ' Max@Example.COM ', phone: '0151 000 0000' });
  assert.equal(valid, true);
  assert.equal(order.email, 'max@example.com');
  assert.equal(order.phone, '+491510000000');
  assert.equal(order.payload.iban, 'DE00000000000000000000');
  assert.equal(order.payload.birth_date, '1990-01-01');
  assert.equal(order.source, 'facebook');
  assert.equal(order.blocked, false);
  assert.equal(order.meta.ip, '203.0.113.7'); // the explicit field wins over the header
  assert.equal('token' in order.payload, false);
});

test('validate: falls back to request headers and direct source', () => {
  const { order } = validate({ ...payload, client_ip: '', user_agent: '', fbc: '', original_url: 'https://landing.example/' });
  assert.equal(order.meta.ip, '198.51.100.1');
  assert.equal(order.meta.user_agent, 'header-agent');
  assert.equal(order.source, 'direct');
});

test('validate: blocks an underage customer without an error', () => {
  const year = new Date().getUTCFullYear() - 17;
  const { valid, order } = validate({ ...payload, birth_date: `01.01.${year}` });
  assert.equal(valid, true);
  assert.equal(order.blocked, true);
});

test('validate: reports every broken field at once', () => {
  const { valid, errors } = validate({ ...payload, email: 'nope', iban: '', birth_date: '31.02.1990', terms: 'x' });
  assert.equal(valid, false);
  assert.deepEqual(Object.keys(errors).sort(), ['birth_date', 'email', 'iban', 'terms']);
});

const hubspotData = (order, check = {}) => run('order-processing', 'HubSpot data', {
  'Claim order': { id: '1000001', email: 'max@example.com', phone: '+49151000', price: '9.99', product_name: 'Mobile 10 GB',
    hubspot_pipeline: 'default', hubspot_stage: 'new', hubspot_duplicate_stage: 'dup', meta: { ip: '203.0.113.7' }, ...order },
  'Check duplicate': { contact_id: null, is_good_duplicate: false, last_deal_id: null, ...check },
});
const form = { first_name: 'Max', last_name: 'Mustermann', street: 'Musterstr.', house_number: '1', postal_code: '10115',
  city: 'Berlin', birth_date: '1990-01-01', iban: 'DE00', original_url: 'https://landing.example/order?x=1' };

test('hubspot data: maps a new order to the regular stage', () => {
  const { contact, deal } = hubspotData({ payload: { ...form, id_valid_until: '01.01.2030' } });
  assert.equal(deal.dealname, 'Max Mustermann');
  assert.equal(deal.dealstage, 'new');
  assert.equal(deal.source_domain, 'landing.example');
  assert.equal(contact.address, 'Musterstr. 1');
  assert.equal(contact.id_valid_until, '2030-01-01');
});

test('hubspot data: sends a good duplicate to the duplicate stage', () => {
  const { deal, contact } = hubspotData({ payload: form }, { is_good_duplicate: true, last_deal_id: '77' });
  assert.equal(deal.dealstage, 'dup');
  assert.equal(deal.description, 'Previous deal: 77');
  assert.equal(contact.id_valid_until, undefined); // product without id document fields
});
