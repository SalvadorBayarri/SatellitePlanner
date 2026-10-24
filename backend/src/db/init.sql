CREATE TABLE IF NOT EXISTS geo_events (
  id UUID PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  latitude DECIMAL(9, 6) NOT NULL,
  longitude DECIMAL(9, 6) NOT NULL,
  intensity FLOAT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO geo_events (id, title, latitude, longitude, intensity, created_at) VALUES
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Tokyo Orbital Telemetry Downlink', 35.676200, 139.650300, 0.92, CURRENT_TIMESTAMP - INTERVAL '95 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'Madrid Deep Space Network Relay', 40.416775, -3.703790, 0.85, CURRENT_TIMESTAMP - INTERVAL '90 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13', 'New York Atlantic Gateway Burst', 40.712776, -74.005974, 0.88, CURRENT_TIMESTAMP - INTERVAL '85 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14', 'Sao Paulo South Atlantic Anomaly Scan', -23.550520, -46.633308, 0.96, CURRENT_TIMESTAMP - INTERVAL '80 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15', 'Sydney Southern Cross Tracking Pass', -33.868820, 151.209290, 0.78, CURRENT_TIMESTAMP - INTERVAL '75 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a16', 'London Ka-Band High Throughput Link', 51.507351, -0.127758, 0.74, CURRENT_TIMESTAMP - INTERVAL '70 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a17', 'Cairo Equatorial Ionosphere Calibration', 30.044420, 31.235712, 0.69, CURRENT_TIMESTAMP - INTERVAL '65 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a18', 'Mumbai Monsoon SAR Imaging Pass', 19.075983, 72.877655, 0.89, CURRENT_TIMESTAMP - INTERVAL '60 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a19', 'Singapore Maritime AIS Constellation Sync', 1.352083, 103.819836, 0.94, CURRENT_TIMESTAMP - INTERVAL '55 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a20', 'Nairobi Rift Valley Geodesy Capture', -1.292066, 36.821946, 0.72, CURRENT_TIMESTAMP - INTERVAL '50 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a21', 'Buenos Aires Polar Orbit Handover', -34.603684, -58.381559, 0.81, CURRENT_TIMESTAMP - INTERVAL '45 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'San Francisco LEO Constellation Command', 37.774929, -122.419416, 0.91, CURRENT_TIMESTAMP - INTERVAL '40 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a23', 'Reykjavik High-Latitude Ground Station', 64.146582, -21.942635, 0.87, CURRENT_TIMESTAMP - INTERVAL '35 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a24', 'Johannesburg Telemetry Uplink Station', -26.204103, 28.047305, 0.76, CURRENT_TIMESTAMP - INTERVAL '30 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a25', 'Seoul Optical Laser Comm Experiment', 37.566535, 126.977969, 0.95, CURRENT_TIMESTAMP - INTERVAL '25 minutes'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a26', 'Svalbard Polar Satellite Ground Terminal', 78.223172, 15.626723, 0.98, CURRENT_TIMESTAMP - INTERVAL '15 minutes')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS satellite_fleet (
  id UUID PRIMARY KEY,
  orbit_altitude_km FLOAT NOT NULL,
  orbit_orientation_deg FLOAT NOT NULL,
  reference_latitude_deg FLOAT NOT NULL,
  reference_direction INT NOT NULL,
  reference_timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO satellite_fleet (id, orbit_altitude_km, orbit_orientation_deg, reference_latitude_deg, reference_direction, reference_timestamp) VALUES
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b01', 642.5, -180.0,  14.25,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b02', 687.1, -168.0, -52.80, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b03', 615.8, -156.0,  73.10,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b04', 663.4, -144.0, -18.45, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b05', 609.2, -132.0,  41.60,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b06', 694.7, -120.0, -81.30,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b07', 631.9, -108.0,   6.75, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b08', 678.3,  -96.0, -37.90,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b09', 654.0,  -84.0,  62.40, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b10', 621.6,  -72.0, -64.15, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b11', 689.5,  -60.0,  28.90,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b12', 604.8,  -48.0, -11.20,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b13', 671.2,  -36.0,  84.50, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b14', 638.9,  -24.0, -45.60, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b15', 659.3,  -12.0,  19.85,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b16', 612.7,    0.0, -72.40,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b17', 683.4,   12.0,  53.20, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b18', 647.1,   24.0, -29.75,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b19', 698.2,   36.0,   3.40, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b20', 626.5,   48.0,  67.80,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b21', 661.8,   60.0, -58.90, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b22', 607.4,   72.0,  34.15,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b23', 675.9,   84.0, -86.20,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b24', 649.6,   96.0,  12.60, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b25', 619.3,  108.0, -22.35, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b26', 691.0,  120.0,  77.90,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b27', 634.2,  132.0, -41.10,  1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b28', 668.7,  144.0,  48.75, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b29', 602.1,  156.0, -69.50, -1, CURRENT_TIMESTAMP),
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380b30', 681.5,  168.0, -15.30,  1, CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;
