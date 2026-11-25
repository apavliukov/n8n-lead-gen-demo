// In-memory stand-in for the external providers of the test stand: HubSpot CRM, the Meta
// Conversions API, TypeSafe Jev and the Telegram Bot API. Implements only the calls the workflows make.
// Control endpoints: GET /__requests (everything received so far), POST /__reset,
// POST /__heal {event_id} (stop failing the Meta events of that order).
import { createServer } from 'node:http';

let contacts = [];
let deals = [];
let requests = [];
let nextId = 1000;
const healed = new Set();

const matches = (object, filter) => {
  if (filter.propertyName === 'associations.contact') return filter.values.includes(object.contactId);
  return filter.value != null && object.properties[filter.propertyName] === filter.value;
};

// HubSpot search: filter groups are OR-ed, filters inside a group are AND-ed.
const search = (objects, { filterGroups = [], sorts = [], limit = 10 }) => {
  const results = objects.filter((o) => filterGroups.some((g) => g.filters.every((f) => matches(o, f))));
  if (sorts[0]?.propertyName === 'createdate') {
    results.sort((a, b) => b.properties.createdate.localeCompare(a.properties.createdate));
  }
  return [200, { total: results.length, results: results.slice(0, limit) }];
};

const create = (objects, body) => {
  const now = new Date().toISOString();
  const object = {
    id: String(nextId++),
    // Tests seed old deals by passing createdate; real HubSpot sets it itself.
    properties: { createdate: now, ...body.properties },
    createdAt: now,
    contactId: body.associations?.[0]?.to.id,
  };
  objects.push(object);
  return [201, object];
};

const handle = (method, path, body) => {
  if (method === 'GET' && path === '/__requests') return [200, requests];
  if (method === 'POST' && path === '/__reset') {
    contacts = [];
    deals = [];
    requests = [];
    return [200, {}];
  }
  if (method === 'POST' && path === '/__heal') {
    healed.add(body.event_id);
    return [200, {}];
  }
  requests.push({ method, path, body });

  if (path === '/crm/v3/objects/contacts/search') return search(contacts, body);
  if (path === '/crm/v3/objects/deals/search') return search(deals, body);
  if (path === '/crm/v3/objects/contacts') {
    // Like real HubSpot, which rejects addresses in a reserved top-level domain.
    if (body.properties.email.endsWith('.invalid')) {
      return [400, { status: 'error', category: 'VALIDATION_ERROR', message: 'Property values were not valid: INVALID_EMAIL' }];
    }
    if (contacts.some((c) => c.properties.email === body.properties.email)) {
      return [409, { status: 'error', category: 'CONFLICT', message: 'Contact already exists' }];
    }
    return create(contacts, body);
  }
  if (path === '/crm/v3/objects/deals') return create(deals, body);
  if (/^\/v[\d.]+\/[^/]+\/events$/.test(path)) {
    // Failure on demand: events of an order whose landing URL contains "meta-fail" are rejected
    // until the test heals that order. The nodes retry on their own, so failing once is not enough.
    const [event] = body.data;
    if (event.event_source_url?.includes('meta-fail') && !healed.has(event.event_id)) {
      return [400, { error: { message: 'Invalid parameter', type: 'OAuthException' } }];
    }
    return [200, { events_received: 1 }];
  }
  if (path === '/v1/systemone') {
    // TypeSafe Jev: the verdict follows the first name, so tests choose it. "jev-down" makes the API fail.
    const name = body.state.first_name;
    if (name === 'jev-down') return [529, { detail: 'Overloaded' }];
    const choice = ['spam', 'suspicious'].includes(name) ? name : 'ok';
    const probabilities = { ok: 0.01, suspicious: 0.01, spam: 0.01, [choice]: 0.98 };
    return [200, { model: 'jev-stub', answers: { verdict: { type: 'choice', choice, confidence: 0.97, probabilities } } }];
  }
  if (/^\/bot[^/]+\/sendMessage$/.test(path)) {
    return [200, { ok: true, result: { message_id: nextId++, chat: { id: body.chat_id }, text: body.text } }];
  }
  return [404, { message: `stub: no route for ${method} ${path}` }];
};

createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let status;
  let payload;
  try {
    [status, payload] = handle(req.method, new URL(req.url, 'http://stub').pathname, raw ? JSON.parse(raw) : {});
  } catch (error) {
    [status, payload] = [500, { message: `stub: ${error.message}` }];
  }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
}).listen(8080, () => console.log('stub listening on 8080'));
