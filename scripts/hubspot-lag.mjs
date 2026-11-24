// Measure how long HubSpot takes to make a new contact and its deal visible to the search API.
// The pipeline relies on this: orders of one customer are processed at least a minute apart
// so that the duplicate check can find the previous deal.
// Usage: HUBSPOT_TOKEN=... node scripts/hubspot-lag.mjs [rounds=3]
//   (or keep HUBSPOT_TOKEN in the local .env and add --env-file=.env)
// Creates one test contact and one deal per round in the real account and deletes them afterwards.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const token = process.env.HUBSPOT_TOKEN;
if (!token) throw new Error('set HUBSPOT_TOKEN');
const base = process.env.HUBSPOT_URL ?? 'https://api.hubapi.com';
const rounds = Number(process.argv[2] ?? 3);
const TIMEOUT_MS = 120_000;
const POLL_MS = 500;

const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};

// Seconds until the search returns at least one result, polling like a second order would.
const visibleAfter = async (path, query, since) => {
  while (Date.now() - since < TIMEOUT_MS) {
    const { results } = await api('POST', path, query);
    if (results.length) return (Date.now() - since) / 1000;
    await sleep(POLL_MS);
  }
  return Infinity;
};

const lags = { contact: [], deal: [] };
for (let round = 1; round <= rounds; round++) {
  const email = `lag-test-${randomUUID()}@example.com`;
  const contact = await api('POST', '/crm/v3/objects/contacts', { properties: { email } });
  const contactAt = Date.now();
  const deal = await api('POST', '/crm/v3/objects/deals', {
    properties: { dealname: 'Search lag test' },
    associations: [{ to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }],
  });
  const dealAt = Date.now();

  try {
    // The same searches the "Duplicate check" workflow runs.
    const [contactLag, dealLag] = await Promise.all([
      visibleAfter('/crm/v3/objects/contacts/search', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      }, contactAt),
      visibleAfter('/crm/v3/objects/deals/search', {
        filterGroups: [{ filters: [{ propertyName: 'associations.contact', operator: 'IN', values: [contact.id] }] }],
      }, dealAt),
    ]);
    lags.contact.push(contactLag);
    lags.deal.push(dealLag);
    console.log(`round ${round}: contact ${contactLag.toFixed(1)} s, deal ${dealLag.toFixed(1)} s`);
  } finally {
    await api('DELETE', `/crm/v3/objects/deals/${deal.id}`).catch((e) => console.error(`cleanup: ${e.message}`));
    await api('DELETE', `/crm/v3/objects/contacts/${contact.id}`).catch((e) => console.error(`cleanup: ${e.message}`));
  }
}

for (const [name, values] of Object.entries(lags)) {
  console.log(`${name}: min ${Math.min(...values).toFixed(1)} s, max ${Math.max(...values).toFixed(1)} s`);
}
