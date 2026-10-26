CREATE TABLE IF NOT EXISTS satellite_fleet (
  id UUID PRIMARY KEY,
  orbit_altitude_km FLOAT NOT NULL,
  orbit_orientation_deg FLOAT NOT NULL,
  reference_latitude_deg FLOAT NOT NULL,
  reference_direction INT NOT NULL,
  reference_timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'active'
);

INSERT INTO satellite_fleet (id, orbit_altitude_km, orbit_orientation_deg, reference_latitude_deg, reference_direction, reference_timestamp) VALUES
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 642.5, -90.0,  14.25,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b02', 687.1, -84.0, -52.80, -1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b03', 615.8, -78.0,  73.10,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b04', 663.4, -72.0, -18.45, -1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b05', 609.2, -66.0,  41.60,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b06', 694.7, -60.0, -81.30,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b07', 631.9, -54.0,   6.75, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b08', 678.3, -48.0, -37.90,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b09', 654.0, -42.0,  62.40, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b10', 621.6, -36.0, -64.15, -1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b11', 689.5, -30.0,  28.90,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b12', 604.8, -24.0, -11.20,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b13', 671.2, -18.0,  84.50, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b14', 638.9, -12.0, -45.60, -1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b15', 659.3,  -6.0,  19.85,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b16', 612.7,   0.0, -72.40,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b17', 683.4,   6.0,  53.20, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b18', 647.1,  12.0, -29.75,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b19', 698.2,  18.0,   3.40, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b20', 626.5,  24.0,  67.80,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b21', 661.8,  30.0, -58.90, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b22', 607.4,  36.0,  34.15,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b23', 675.9,  42.0, -86.20,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b24', 649.6,  48.0,  12.60, -1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b25', 619.3,  54.0, -22.35, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b26', 691.0,  60.0,  77.90,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b27', 634.2,  66.0, -41.10,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b28', 668.7,  72.0,  48.75, -1, CURRENT_TIMESTAMP - INTERVAL '48 minutes'),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b29', 602.1,  78.0, -69.50, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b30', 681.5,  84.0, -15.30,  1, CURRENT_TIMESTAMP - INTERVAL '48 minutes')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  name VARCHAR(255) NOT NULL
);

INSERT INTO users (id, name) VALUES
  ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c01', 'system'),
  ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380c02', 'demo')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS acquisition_plan (
  id UUID PRIMARY KEY,
  satellite_id UUID NOT NULL,
  user_id UUID NOT NULL,
  acquisition_timestamp TIMESTAMPTZ NOT NULL,
  duration_seconds INT NOT NULL DEFAULT 20,
  center_longitude_deg FLOAT NOT NULL,
  center_latitude_deg FLOAT NOT NULL,
  width_m FLOAT NOT NULL,
  height_m FLOAT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Pending',
  acquired_image TEXT,
  reprogrammed_from_id UUID
);

CREATE TABLE IF NOT EXISTS acquisition_requests (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  center_longitude_deg FLOAT NOT NULL,
  center_latitude_deg FLOAT NOT NULL,
  width_m FLOAT NOT NULL,
  height_m FLOAT NOT NULL,
  time_mode VARCHAR(32) NOT NULL,
  requested_timestamp TIMESTAMPTZ,
  confirmation_mode VARCHAR(32) NOT NULL DEFAULT 'manual',
  reprogrammed_from_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(32) NOT NULL DEFAULT 'Queued'
);

ALTER TABLE satellite_fleet ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'active';
ALTER TABLE acquisition_plan ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE acquisition_plan ADD COLUMN IF NOT EXISTS reprogrammed_from_id UUID;
ALTER TABLE acquisition_requests ADD COLUMN IF NOT EXISTS confirmation_mode VARCHAR(32) DEFAULT 'manual';
ALTER TABLE acquisition_requests ADD COLUMN IF NOT EXISTS reprogrammed_from_id UUID;
