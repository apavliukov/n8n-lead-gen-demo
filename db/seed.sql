-- Demo data: one site, two products, three providers. Idempotent.
-- In production these tables are maintained by the back-office app; n8n only reads them.
SET search_path TO leadgen;

INSERT INTO sites (id, token, name, email_from, email_from_name, email_verified_url)
VALUES (1, '11111111-1111-4111-8111-111111111111', 'Demo landing', 'orders@example.com', 'Demo Shop', 'https://example.com/?email-verified')
ON CONFLICT (id) DO NOTHING;

-- 'default' and 'appointmentscheduled' are the ids of HubSpot's built-in sales pipeline and its first stage.
-- Stage ids are fixed at creation and survive renames, so they do not match the stage names.
-- hubspot_duplicate_stage is account-specific: create a "Duplicate" stage and replace the id below with yours.
INSERT INTO products (id, site_id, external_id, name, price, required_fields, hubspot_pipeline, hubspot_stage, hubspot_duplicate_stage)
VALUES
    (1, 1, 'mobile-10gb', 'Mobile 10 GB', 9.99, '["birth_place", "id_number", "id_valid_until"]', 'default', 'appointmentscheduled', '6503850198'),
    (2, 1, 'dsl-100', 'DSL 100', 29.99, '[]', 'default', 'appointmentscheduled', '6503850198')
ON CONFLICT (id) DO NOTHING;

INSERT INTO providers (id, type, name)
VALUES
    (1, 'hubspot', 'HubSpot'),
    (2, 'meta', 'Meta Conversions API'),
    (3, 'email', 'Transactional email')
ON CONFLICT (id) DO NOTHING;

INSERT INTO site_providers (site_id, provider_id, settings)
VALUES
    (1, 1, '{}'),
    (1, 2, '{"pixel_id": "REPLACE_ME"}'),
    (1, 3, '{}')
ON CONFLICT (site_id, provider_id) DO NOTHING;

-- Explicit ids above do not advance the sequences.
SELECT setval(pg_get_serial_sequence('sites', 'id'), (SELECT max(id) FROM sites));
SELECT setval(pg_get_serial_sequence('products', 'id'), (SELECT max(id) FROM products));
SELECT setval(pg_get_serial_sequence('providers', 'id'), (SELECT max(id) FROM providers));
