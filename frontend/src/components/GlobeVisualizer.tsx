import React, { useEffect, useRef } from 'react';
import Globe, { GlobeInstance } from 'globe.gl';
import * as THREE from 'three';
import {
  SatelliteConfig,
  SatellitePosition,
  AcquisitionPlanRow,
  computeSatellitePosition,
  computeSubsolarPoint,
  getGlobeAltitudeRatio,
  getSatelliteColor,
  formatAcquisitionRemainingTime,
} from '../services/api';

interface GlobeVisualizerProps {
  satellites: SatelliteConfig[];
  selectedSatelliteId: string | null;
  selectedAcquisition: AcquisitionPlanRow | null;
  acquisitionFocusKey?: number;
  trackSelectedSatellite: boolean;
  onSelectSatellite: (satellite: SatellitePosition) => void;
  onFocusAcquisition?: () => void;
  isPickingLocation?: boolean;
  onPickLocation?: (coords: { lat: number; lng: number }) => void;
  getSimulatedTimeMs: () => number;
  autoRotate: boolean;
}

interface AcquisitionRenderObject {
  isAcquisitionTarget: true;
  id: string;
  acquisition: AcquisitionPlanRow;
  color: string;
}

type GlobeSceneObject = SatellitePosition | AcquisitionRenderObject;

function isAcquisitionObject(obj: any): obj is AcquisitionRenderObject {
  return Boolean(obj && obj.isAcquisitionTarget === true);
}

/**
 * Returns the exact status badge color used in the Satellite Info Panel (.acq-status-badge)
 */
function getAcquisitionStatusColor(status: string): string {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'completed') return '#34d399'; // Emerald green (.acq-status-badge.completed)
  if (normalized === 'acquiring') return '#38bdf8'; // Sky cyan (.acq-status-badge.acquiring)
  if (normalized === 'reserved') return '#c084fc'; // Violet purple (.acq-status-badge.reserved)
  if (normalized === 'failed') return '#fb7185'; // Rose red (.acq-status-badge.failed)
  return '#fbbf24'; // Amber gold (.acq-status-badge.pending)
}

const EARTH_RADIUS_KM = 6371;
const GLOBE_RADIUS_UNITS = 100;
const FOOTPRINT_SIZE_KM = 300;
const FOOTPRINT_SIZE_UNITS = (FOOTPRINT_SIZE_KM / EARTH_RADIUS_KM) * GLOBE_RADIUS_UNITS;
const MAX_ORBIT_TRACE_POINTS = 2400;

// Shared geometries for satellites, footprints, and selection highlight halos
const satBodyGeom = new THREE.SphereGeometry(1.15, 32, 32);
const satWingGeom = new THREE.BoxGeometry(4.6, 0.75, 0.14);
const satShaftGeom = new THREE.CylinderGeometry(0.18, 0.18, 2.6, 12);
const satHeadGeom = new THREE.ConeGeometry(0.62, 1.45, 16);
const footprintPlaneGeom = new THREE.PlaneGeometry(FOOTPRINT_SIZE_UNITS, FOOTPRINT_SIZE_UNITS);
const footprintBorderEdgesGeom = new THREE.EdgesGeometry(footprintPlaneGeom);

// Highlight Halo geometries (shown around the selected satellite when the info popup is open)
const haloSphereGeom = new THREE.SphereGeometry(2.9, 24, 24);
const haloInnerRingGeom = new THREE.TorusGeometry(3.4, 0.18, 12, 48);
const haloOuterRingGeom = new THREE.TorusGeometry(4.4, 0.11, 12, 48);

/**
 * Creates a camera-space volumetric 3D shaded sphere material (Blinn-Phong with dark shadow edge
 * and specular highlight) so spheres always render with crisp 3D depth regardless of globe scene ambient lighting.
 */
function createVolumetricSphereMaterial(initialColor: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: initialColor.clone() },
    },
    vertexShader: `
      varying vec3 vViewNormal;
      void main() {
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying vec3 vViewNormal;
      void main() {
        vec3 N = normalize(vViewNormal);
        vec3 keyLight = normalize(vec3(-0.48, 0.58, 0.66));
        vec3 fillLight = normalize(vec3(0.55, -0.35, 0.45));
        vec3 viewDir = vec3(0.0, 0.0, 1.0);

        float diffKey = max(dot(N, keyLight), 0.0);
        float diffFill = max(dot(N, fillLight), 0.0) * 0.22;

        vec3 halfVec = normalize(keyLight + viewDir);
        float spec = pow(max(dot(N, halfVec), 0.0), 34.0) * 0.55;

        // Deep shadow core (0.15) up to bright lit side + white specular highlight for 3D volume
        vec3 shaded = uColor * (0.15 + 0.88 * diffKey + diffFill) + vec3(spec);
        gl_FragColor = vec4(shaded, 1.0);
      }
    `,
  });
}

/**
 * Converts geographic (lat, lng) into ThreeGlobe's unit Cartesian vector
 */
function latLngToUnitVector(lat: number, lng: number): THREE.Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((90 - lng) * Math.PI) / 180;
  const phiSin = Math.sin(phi);
  return new THREE.Vector3(
    phiSin * Math.cos(theta),
    Math.cos(phi),
    phiSin * Math.sin(theta)
  ).normalize();
}

/**
 * Builds a custom-colored 3D satellite mesh + a matching 300x300 km semitransparent surface footprint square
 * + a toggleable glowing highlight halo around the satellite when selected.
 */
function createSatelliteAndFootprintMesh(sat: SatellitePosition): THREE.Group {
  const group = new THREE.Group();
  const baseColor = new THREE.Color(sat.color);

  // 1. Central satellite bus sphere (volumetrically 3D shaded per satellite)
  const bodyMat = createVolumetricSphereMaterial(baseColor);
  const bodyMesh = new THREE.Mesh(satBodyGeom, bodyMat);
  group.add(bodyMesh);

  // 2. Solar panel wings (tinted with the satellite's unique color)
  const wingMat = new THREE.MeshPhongMaterial({
    color: baseColor,
    emissive: baseColor,
    emissiveIntensity: 0.35,
    shininess: 100,
  });
  const wingMesh = new THREE.Mesh(satWingGeom, wingMat);
  group.add(wingMesh);

  // 3. Dynamic motion direction arrow pointing along local +Y (rotated by objectRotation.z = headingDeg)
  const arrowMat = new THREE.MeshPhongMaterial({
    color: baseColor,
    emissive: baseColor,
    emissiveIntensity: 0.85,
    shininess: 100,
  });

  const shaftMesh = new THREE.Mesh(satShaftGeom, arrowMat);
  shaftMesh.position.set(0, 2.2, 0);
  group.add(shaftMesh);

  const headMesh = new THREE.Mesh(satHeadGeom, arrowMat);
  headMesh.position.set(0, 4.1, 0);
  group.add(headMesh);

  // 4. Highlight Halo Group (only visible when this satellite is selected and the info popup is open)
  const haloGroup = new THREE.Group();
  haloGroup.name = 'selectionHalo';
  haloGroup.visible = false;

  const haloSphereMat = new THREE.MeshBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
  });
  const haloSphereMesh = new THREE.Mesh(haloSphereGeom, haloSphereMat);
  haloGroup.add(haloSphereMesh);

  const haloInnerRingMat = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
  });
  const haloInnerRingMesh = new THREE.Mesh(haloInnerRingGeom, haloInnerRingMat);
  haloGroup.add(haloInnerRingMesh);

  const haloOuterRingMat = new THREE.MeshBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: 0.78,
    side: THREE.DoubleSide,
  });
  const haloOuterRingMesh = new THREE.Mesh(haloOuterRingGeom, haloOuterRingMat);
  haloGroup.add(haloOuterRingMesh);

  group.add(haloGroup);
  group.userData.haloGroup = haloGroup;

  // 5. Semitransparent 300x300 km capture coverage square projected onto the globe surface below the satellite
  const altRatio = getGlobeAltitudeRatio(sat.orbit_altitude_km);
  const surfaceOffsetZ = -GLOBE_RADIUS_UNITS * altRatio + 0.45;

  const footprintMat = new THREE.MeshBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: 0.32,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const footprintMesh = new THREE.Mesh(footprintPlaneGeom, footprintMat);
  footprintMesh.position.set(0, 0, surfaceOffsetZ);

  const borderMat = new THREE.LineBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: 0.9,
  });
  const borderLines = new THREE.LineSegments(footprintBorderEdgesGeom, borderMat);
  footprintMesh.add(borderLines);

  group.add(footprintMesh);

  group.userData.colorHex = sat.color;
  group.userData.shadedSphereMat = bodyMat;
  group.userData.phongMaterials = [wingMat, arrowMat];
  group.userData.basicMaterials = [haloSphereMat, haloOuterRingMat, footprintMat, borderMat];

  return group;
}

function updateSatelliteMeshColor(group: THREE.Group, nextColorHex: string): void {
  if (group.userData.colorHex === nextColorHex) return;
  group.userData.colorHex = nextColorHex;
  const nextColor = new THREE.Color(nextColorHex);

  const shadedSphereMat = group.userData.shadedSphereMat as THREE.ShaderMaterial | undefined;
  if (shadedSphereMat) {
    shadedSphereMat.uniforms.uColor.value.copy(nextColor);
  }

  const phongMats = group.userData.phongMaterials as THREE.MeshPhongMaterial[] | undefined;
  if (phongMats) {
    phongMats.forEach((mat) => {
      mat.color.copy(nextColor);
      mat.emissive.copy(nextColor);
    });
  }

  const basicMats = group.userData.basicMaterials as
    | Array<THREE.MeshBasicMaterial | THREE.LineBasicMaterial>
    | undefined;
  if (basicMats) {
    basicMats.forEach((mat) => {
      mat.color.copy(nextColor);
    });
  }
}

/**
 * Draws the 3D floating HUD text canvas for an acquisition target on the globe,
 * highlighting both the live remaining countdown and the planned UTC time.
 */
function drawAcquisitionTargetLabelCanvas(
  canvas: HTMLCanvasElement,
  acq: AcquisitionPlanRow,
  satColorHex: string,
  nowMs: number
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const statusColorHex = getAcquisitionStatusColor(acq.status);
  const remInfo = formatAcquisitionRemainingTime(acq, nowMs);
  const shortSat = acq.satellite_id.slice(-4).toUpperCase();
  const plannedUtcStr = new Date(acq.acquisition_timestamp)
    .toISOString()
    .replace('T', ' ')
    .slice(11, 19);

  const pad = 10;
  const r = 18;
  const bx = pad;
  const by = pad;
  const bw = w - pad * 2;
  const bh = h - pad * 2;

  // Rounded dark glass card background
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, r);
  ctx.fillStyle = 'rgba(7, 13, 28, 0.90)';
  ctx.fill();

  // Status-colored glowing border
  ctx.lineWidth = 3;
  ctx.strokeStyle = statusColorHex;
  ctx.shadowColor = statusColorHex;
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.restore();

  // Satellite & Status top line
  ctx.save();
  ctx.beginPath();
  ctx.arc(bx + 26, by + 32, 7, 0, Math.PI * 2);
  ctx.fillStyle = satColorHex;
  ctx.fill();

  ctx.font = '700 20px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = '#e2e8f0';
  ctx.textBaseline = 'middle';
  ctx.fillText(`SAT-${shortSat} • ${acq.status.toUpperCase()}`, bx + 42, by + 32);

  // Prominent Remaining Time middle line
  ctx.font = '800 27px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = statusColorHex;
  ctx.fillText(`⏱ ${remInfo.globeLabel}`, bx + 20, by + 76);

  // Planned UTC time & target coordinates bottom line
  ctx.font = '600 18px "JetBrains Mono", Consolas, monospace';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(
    `PLANNED: ${plannedUtcStr} UTC • (${acq.center_latitude_deg.toFixed(1)}°, ${acq.center_longitude_deg.toFixed(1)}°)`,
    bx + 20,
    by + 116
  );
  ctx.restore();
}

function updateAcquisitionTargetLabel(
  group: THREE.Group,
  acq: AcquisitionPlanRow,
  satColorHex: string,
  nowMs: number
): void {
  const remInfo = formatAcquisitionRemainingTime(acq, nowMs);
  const nextKey = `${acq.id}:${acq.status}:${remInfo.diffSeconds}:${satColorHex}`;
  if (group.userData.labelStateKey === nextKey) return;
  group.userData.labelStateKey = nextKey;

  const canvas = group.userData.labelCanvas as HTMLCanvasElement | undefined;
  const texture = group.userData.labelTexture as THREE.CanvasTexture | undefined;
  if (!canvas || !texture) return;

  drawAcquisitionTargetLabelCanvas(canvas, acq, satColorHex, nowMs);
  texture.needsUpdate = true;
}

/**
 * Builds the highlighted acquisition target rectangle on the globe surface at the exact
 * physical scale (width_m along geographic parallels, height_m along meridians), plus
 * a pulsing highlight frame and a floating 3D text billboard showing the remaining time.
 */
function createAcquisitionTargetMesh(
  acq: AcquisitionPlanRow,
  colorHex: string,
  initialNowMs: number
): THREE.Group {
  const group = new THREE.Group();
  const baseColor = new THREE.Color(colorHex);

  const widthKm = acq.width_m / 1000;
  const heightKm = acq.height_m / 1000;
  const widthUnits = Math.max(0.05, (widthKm / EARTH_RADIUS_KM) * GLOBE_RADIUS_UNITS);
  const heightUnits = Math.max(0.05, (heightKm / EARTH_RADIUS_KM) * GLOBE_RADIUS_UNITS);

  // 1. Exact physical width x height acquisition surface rectangle
  const exactPlaneGeom = new THREE.PlaneGeometry(widthUnits, heightUnits);
  const exactFillMat = new THREE.MeshBasicMaterial({
    color: baseColor,
    transparent: true,
    opacity: 0.62,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const exactRectMesh = new THREE.Mesh(exactPlaneGeom, exactFillMat);
  group.add(exactRectMesh);

  // Crisp bright white border along the exact acquisition rectangle perimeter
  const exactEdgesGeom = new THREE.EdgesGeometry(exactPlaneGeom);
  const exactBorderMat = new THREE.LineBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 1.0,
  });
  const exactBorderLines = new THREE.LineSegments(exactEdgesGeom, exactBorderMat);
  exactBorderLines.position.set(0, 0, 0.02);
  group.add(exactBorderLines);

  // 2. Pulsing highlight halo frame & locator ring colored to match the acquisition status text in the panel
  const statusColor = new THREE.Color(getAcquisitionStatusColor(acq.status));
  const highlightGroup = new THREE.Group();
  const haloSpanW = widthUnits + 0.32;
  const haloSpanH = heightUnits + 0.32;
  const outerFrameGeom = new THREE.PlaneGeometry(haloSpanW, haloSpanH);
  const outerFrameEdges = new THREE.EdgesGeometry(outerFrameGeom);
  const outerFrameMat = new THREE.LineBasicMaterial({
    color: statusColor,
    transparent: true,
    opacity: 0.95,
  });
  const outerFrameLines = new THREE.LineSegments(outerFrameEdges, outerFrameMat);
  outerFrameLines.position.set(0, 0, 0.03);
  highlightGroup.add(outerFrameLines);

  const ringRadius = Math.max(widthUnits, heightUnits) * 0.75 + 0.35;
  const locatorRingGeom = new THREE.RingGeometry(ringRadius, ringRadius + 0.14, 36);
  const locatorRingMat = new THREE.MeshBasicMaterial({
    color: statusColor,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const locatorRingMesh = new THREE.Mesh(locatorRingGeom, locatorRingMat);
  locatorRingMesh.position.set(0, 0, 0.01);
  highlightGroup.add(locatorRingMesh);

  group.add(highlightGroup);

  // 3. Displaced 3D callout leader & floating 3D HUD billboard to the right of the target location
  const leadStartX = ringRadius + 0.12;
  const leadElbowX = ringRadius + 1.55;
  const leadEndX = ringRadius + 2.35;
  const leadEndZ = 1.35;

  const stemGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(leadStartX, 0, 0.04),
    new THREE.Vector3(leadElbowX, 0, leadEndZ),
    new THREE.Vector3(leadEndX, 0, leadEndZ),
  ]);
  const stemMat = new THREE.LineBasicMaterial({
    color: statusColor,
    transparent: true,
    opacity: 0.92,
  });
  const stemLine = new THREE.Line(stemGeom, stemMat);
  group.add(stemLine);

  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 620;
  labelCanvas.height = 160;
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  labelTexture.minFilter = THREE.LinearFilter;
  labelTexture.magFilter = THREE.LinearFilter;

  const labelSpriteMat = new THREE.SpriteMaterial({
    map: labelTexture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const labelSprite = new THREE.Sprite(labelSpriteMat);
  // Anchor at the left-center edge (0, 0.5) so the billboard extends strictly to the right of the leader tip
  labelSprite.center.set(0, 0.5);
  labelSprite.position.set(leadEndX + 0.18, 0, leadEndZ);
  labelSprite.scale.set(14.5, 3.75, 1);
  labelSprite.renderOrder = 999;
  group.add(labelSprite);

  group.userData.acqHighlightGroup = highlightGroup;
  group.userData.haloMaterials = [outerFrameMat, locatorRingMat, stemMat];
  group.userData.labelCanvas = labelCanvas;
  group.userData.labelTexture = labelTexture;

  updateAcquisitionTargetLabel(group, acq, colorHex, initialNowMs);

  return group;
}

interface OrbitTraceResources {
  group: THREE.Group;
  orbitLine: THREE.Line;
  orbitPositions: Float32Array;
  orbitColors: Float32Array;
  nadirLine: THREE.Line;
  nadirPositions: Float32Array;
  futureSatMesh: THREE.Mesh;
  futureSatMat: THREE.ShaderMaterial;
}

/**
 * Creates a reusable Three.js group in the globe scene to render the selected satellite's
 * future orbit trace from the current simulated time until the planned acquisition time,
 * plus a nadir capture line connecting the satellite's position at acquisition time to the target area.
 */
function createOrbitTraceResources(): OrbitTraceResources {
  const group = new THREE.Group();
  group.name = 'selectedAcquisitionOrbitTrace';
  group.visible = false;

  const orbitPositions = new Float32Array(MAX_ORBIT_TRACE_POINTS * 3);
  const orbitColors = new Float32Array(MAX_ORBIT_TRACE_POINTS * 3);
  const orbitGeom = new THREE.BufferGeometry();
  orbitGeom.setAttribute('position', new THREE.BufferAttribute(orbitPositions, 3));
  orbitGeom.setAttribute('color', new THREE.BufferAttribute(orbitColors, 3));

  const orbitMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
  });
  const orbitLine = new THREE.Line(orbitGeom, orbitMat);
  orbitLine.frustumCulled = false;
  group.add(orbitLine);

  // Nadir line connecting the satellite's orbital position at acquisition_timestamp down to the target center
  const nadirPositions = new Float32Array(2 * 3);
  const nadirGeom = new THREE.BufferGeometry();
  nadirGeom.setAttribute('position', new THREE.BufferAttribute(nadirPositions, 3));
  const nadirMat = new THREE.LineBasicMaterial({
    color: '#ffffff',
    transparent: true,
    opacity: 0.95,
  });
  const nadirLine = new THREE.Line(nadirGeom, nadirMat);
  nadirLine.frustumCulled = false;
  group.add(nadirLine);

  // Marker at the satellite's orbital position at acquisition_timestamp (half size, 3D volumetrically shaded)
  const futureSatGeom = new THREE.SphereGeometry(0.475, 32, 32);
  const futureSatMat = createVolumetricSphereMaterial(new THREE.Color('#ffffff'));
  const futureSatMesh = new THREE.Mesh(futureSatGeom, futureSatMat);
  futureSatMesh.frustumCulled = false;
  group.add(futureSatMesh);

  return {
    group,
    orbitLine,
    orbitPositions,
    orbitColors,
    nadirLine,
    nadirPositions,
    futureSatMesh,
    futureSatMat,
  };
}

const CONTINENT_POLYGONS: Array<Array<[number, number]>> = [
  // North America
  [[-165, 68], [-130, 70], [-80, 62], [-60, 50], [-75, 35], [-82, 25], [-97, 18], [-105, 22], [-122, 37], [-135, 55]],
  // South America
  [[-80, 10], [-60, 8], [-35, -6], [-42, -23], [-55, -35], [-68, -54], [-74, -45], [-72, -18], [-81, -4]],
  // Europe
  [[-10, 36], [5, 43], [15, 40], [30, 45], [45, 65], [25, 71], [5, 62], [-5, 50]],
  // Africa
  [[-17, 15], [-5, 35], [11, 37], [33, 31], [51, 12], [40, -10], [32, -28], [18, -35], [12, -15], [8, 4], [-8, 5]],
  // Asia
  [[30, 40], [45, 65], [90, 73], [140, 65], [145, 45], [122, 23], [103, 2], [95, 16], [78, 8], [68, 24], [50, 15], [35, 30]],
  // Australia
  [[114, -22], [130, -12], [146, -18], [153, -28], [145, -38], [130, -33], [115, -34]],
  // Greenland
  [[-55, 60], [-20, 65], [-18, 80], [-50, 82], [-60, 72]],
  // Japan / UK / Islands
  [[130, 31], [141, 41], [145, 44], [136, 35]],
];

/**
 * Generates an instant procedural Day or Night Earth texture so the day/night shader works immediately
 * before the high-res Blue Marble Day & Night textures finish loading from CDN.
 */
function createProceduralEarthCanvasTexture(mode: 'day' | 'night'): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;

  if (mode === 'day') {
    const oceanGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    oceanGrad.addColorStop(0, '#0c2d54');
    oceanGrad.addColorStop(0.25, '#0e4175');
    oceanGrad.addColorStop(0.5, '#155e95');
    oceanGrad.addColorStop(0.75, '#0e4175');
    oceanGrad.addColorStop(1, '#0c2d54');
    ctx.fillStyle = oceanGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(34, 153, 130, 0.72)';
    ctx.strokeStyle = 'rgba(125, 211, 252, 0.75)';
    ctx.lineWidth = 2;
  } else {
    // Night Earth: deep dark indigo ocean + dark landmasses + glowing city light clusters
    ctx.fillStyle = '#02050d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = '#070e1c';
    ctx.strokeStyle = 'rgba(30, 58, 138, 0.35)';
    ctx.lineWidth = 1.5;
  }

  for (const poly of CONTINENT_POLYGONS) {
    ctx.beginPath();
    poly.forEach(([lon, lat], idx) => {
      const x = ((lon + 180) / 360) * canvas.width;
      const y = ((90 - lat) / 180) * canvas.height;
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  if (mode === 'night') {
    // Draw glowing city light hubs on the night texture
    const hubs: Array<[number, number, number]> = [
      [-74.0, 40.7, 18], [-87.6, 41.8, 14], [-118.2, 34.0, 15], [-122.4, 37.7, 13],
      [-99.1, 19.4, 14], [-46.6, -23.5, 16], [-58.4, -34.6, 14], [-0.1, 51.5, 18],
      [2.3, 48.8, 17], [-3.7, 40.4, 14], [12.5, 41.9, 14], [13.4, 52.5, 15],
      [37.6, 55.7, 16], [31.2, 30.0, 16], [28.0, -26.2, 13], [55.3, 25.2, 14],
      [72.8, 19.0, 18], [77.2, 28.6, 18], [103.8, 1.35, 15], [114.1, 22.3, 17],
      [121.4, 31.2, 19], [116.4, 39.9, 18], [126.9, 37.5, 16], [139.6, 35.6, 20],
      [151.2, -33.8, 13],
    ];
    for (const [lon, lat, radius] of hubs) {
      const cx = ((lon + 180) / 360) * canvas.width;
      const cy = ((90 - lat) / 180) * canvas.height;
      const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, radius);
      grad.addColorStop(0, 'rgba(254, 240, 138, 0.95)');
      grad.addColorStop(0.4, 'rgba(251, 191, 36, 0.55)');
      grad.addColorStop(1, 'rgba(251, 191, 36, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

/**
 * Custom GLSL ShaderMaterial blending Blue Marble Day & Night textures across the realistic solar terminator.
 */
function createDayNightEarthShaderMaterial(
  dayTexture: THREE.Texture,
  nightTexture: THREE.Texture,
  initialSunDir: THREE.Vector3
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      dayTexture: { value: dayTexture },
      nightTexture: { value: nightTexture },
      sunDirection: { value: initialSunDir.clone() },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldNormal;

      void main() {
        vUv = uv;
        // Compute normal in world space (globeObj has rotation.y = -PI/2)
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D dayTexture;
      uniform sampler2D nightTexture;
      uniform vec3 sunDirection;

      varying vec2 vUv;
      varying vec3 vWorldNormal;

      void main() {
        vec3 normal = normalize(vWorldNormal);
        vec3 sunDir = normalize(sunDirection);

        // Cosine of solar zenith angle: +1 at subsolar point, 0 at terminator, -1 at midnight antipode
        float sunCos = dot(normal, sunDir);

        // Smooth terminator transition between night (-0.12) and day (+0.12)
        float dayMix = smoothstep(-0.12, 0.12, sunCos);

        vec3 dayRgb = texture2D(dayTexture, vUv).rgb;
        vec3 nightRgb = texture2D(nightTexture, vUv).rgb;

        // Bright, vibrant Blue Marble day hemisphere (1.0x near terminator up to 1.22x at subsolar noon)
        float sunHighlight = max(0.0, sunCos);
        vec3 litDay = dayRgb * (1.02 + 0.20 * sunHighlight);

        // Bright night hemisphere showing vivid city lights AND clearly discernible dark-blue continents/oceans
        vec3 nightGeographyBase = dayRgb * vec3(0.22, 0.28, 0.42);
        vec3 litNight = nightGeographyBase + nightRgb * 1.45;

        // Subtle warm golden-amber atmospheric scattering along the terminator line
        float twilightBand = (1.0 - abs(dayMix * 2.0 - 1.0));
        vec3 twilightGlow = vec3(0.95, 0.48, 0.16) * pow(twilightBand, 2.0) * 0.14;

        vec3 finalRgb = mix(litNight, litDay, dayMix) + twilightGlow;
        gl_FragColor = vec4(clamp(finalRgb, 0.0, 1.0), 1.0);
      }
    `,
  });
}

export const GlobeVisualizer: React.FC<GlobeVisualizerProps> = ({
  satellites,
  selectedSatelliteId,
  selectedAcquisition,
  acquisitionFocusKey = 0,
  trackSelectedSatellite,
  onSelectSatellite,
  onFocusAcquisition,
  isPickingLocation = false,
  onPickLocation,
  getSimulatedTimeMs,
  autoRotate,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const satellitesRef = useRef<SatelliteConfig[]>(satellites);
  const selectedSatelliteIdRef = useRef<string | null>(selectedSatelliteId);
  const selectedAcquisitionRef = useRef<AcquisitionPlanRow | null>(selectedAcquisition);
  const trackSelectedSatelliteRef = useRef<boolean>(trackSelectedSatellite);
  const onSelectSatelliteRef = useRef(onSelectSatellite);
  const onFocusAcquisitionRef = useRef(onFocusAcquisition);
  const isPickingLocationRef = useRef<boolean>(isPickingLocation);
  const onPickLocationRef = useRef(onPickLocation);
  const getSimulatedTimeMsRef = useRef(getSimulatedTimeMs);
  const meshCacheRef = useRef<Map<string, THREE.Group>>(new Map());
  const acqMeshCacheRef = useRef<Map<string, THREE.Group>>(new Map());
  const orbitTraceRef = useRef<OrbitTraceResources | null>(null);
  const positionObjectsRef = useRef<SatellitePosition[]>([]);
  const earthShaderMatRef = useRef<THREE.ShaderMaterial | null>(null);

  satellitesRef.current = satellites;
  selectedSatelliteIdRef.current = selectedSatelliteId;
  selectedAcquisitionRef.current = selectedAcquisition;
  trackSelectedSatelliteRef.current = trackSelectedSatellite;
  onSelectSatelliteRef.current = onSelectSatellite;
  onFocusAcquisitionRef.current = onFocusAcquisition;
  isPickingLocationRef.current = isPickingLocation;
  onPickLocationRef.current = onPickLocation;
  getSimulatedTimeMsRef.current = getSimulatedTimeMs;

  const updateSelectionHalos = (activeId: string | null, pulsePhase = 0) => {
    meshCacheRef.current.forEach((group, id) => {
      const haloGroup = group.userData.haloGroup as THREE.Group | undefined;
      if (haloGroup) {
        const isSelected = Boolean(activeId && id === activeId);
        haloGroup.visible = isSelected;
        if (isSelected) {
          const pulseScale = 1 + 0.14 * Math.sin(pulsePhase);
          haloGroup.scale.set(pulseScale, pulseScale, pulseScale);
        }
      }
    });

    const activeAcqStatus = selectedAcquisitionRef.current?.status || 'Pending';
    const activeStatusColor = new THREE.Color(getAcquisitionStatusColor(activeAcqStatus));

    acqMeshCacheRef.current.forEach((group) => {
      const acqHighlightGroup = group.userData.acqHighlightGroup as THREE.Group | undefined;
      if (acqHighlightGroup) {
        const pulseScale = 1 + 0.16 * Math.sin(pulsePhase * 1.25);
        acqHighlightGroup.scale.set(pulseScale, pulseScale, 1);
      }
      const haloMats = group.userData.haloMaterials as
        | Array<THREE.LineBasicMaterial | THREE.MeshBasicMaterial>
        | undefined;
      if (haloMats) {
        haloMats.forEach((mat) => mat.color.copy(activeStatusColor));
      }
    });
  };

  const updateSunPosition = (simMs: number) => {
    if (!earthShaderMatRef.current) return;
    const subsolar = computeSubsolarPoint(simMs);
    const sunVec = latLngToUnitVector(subsolar.lat, subsolar.lng);
    earthShaderMatRef.current.uniforms.sunDirection.value.copy(sunVec);
  };

  /**
   * Updates the 3D orbit trace of the selected satellite from the current simulated time
   * until the planned acquisition timestamp.
   */
  const updateAcquisitionOrbitTrace = (
    simMs: number,
    fleet: SatelliteConfig[],
    activeAcq: AcquisitionPlanRow | null,
    activeSatId: string | null
  ) => {
    const traceRes = orbitTraceRef.current;
    if (!traceRes) return;

    if (!activeAcq || !activeSatId || (activeAcq.status || '').toLowerCase() === 'reprogrammed') {
      traceRes.group.visible = false;
      return;
    }

    const satCfg = fleet.find((s) => s.id === activeAcq.satellite_id);
    if (!satCfg) {
      traceRes.group.visible = false;
      return;
    }

    const targetMs = new Date(activeAcq.acquisition_timestamp).getTime();
    const remainingMs = targetMs - simMs;

    if (remainingMs <= 0) {
      // Acquisition time has already been reached or passed in simulated time
      traceRes.group.visible = false;
      return;
    }

    const satColorHex = getSatelliteColor(satCfg);
    const baseColor = new THREE.Color(satColorHex);
    const whiteColor = new THREE.Color('#ffffff');
    const stepColor = new THREE.Color();

    const altRatio = getGlobeAltitudeRatio(satCfg.orbit_altitude_km);
    const orbitRadius = GLOBE_RADIUS_UNITS * (1 + altRatio);
    const surfaceTargetRadius = GLOBE_RADIUS_UNITS * (1 + 0.0065);

    // Sample at ~30s intervals (minimum 2 steps, capped at MAX_ORBIT_TRACE_POINTS - 1)
    const numSteps = Math.max(
      2,
      Math.min(MAX_ORBIT_TRACE_POINTS - 1, Math.ceil(remainingMs / 30_000))
    );
    const totalPoints = numSteps + 1;

    for (let i = 0; i <= numSteps; i++) {
      const frac = i / numSteps;
      const tMs = simMs + remainingMs * frac;
      const pos = computeSatellitePosition(satCfg, tMs);
      const unitVec = latLngToUnitVector(pos.currentLat, pos.currentLng);

      const idx3 = i * 3;
      traceRes.orbitPositions[idx3] = unitVec.x * orbitRadius;
      traceRes.orbitPositions[idx3 + 1] = unitVec.y * orbitRadius;
      traceRes.orbitPositions[idx3 + 2] = unitVec.z * orbitRadius;

      // Gradient from satellite's vibrant color at current position toward bright white-tinted highlight at acquisition time
      stepColor.copy(baseColor).lerp(whiteColor, frac * 0.42);
      traceRes.orbitColors[idx3] = stepColor.r;
      traceRes.orbitColors[idx3 + 1] = stepColor.g;
      traceRes.orbitColors[idx3 + 2] = stepColor.b;
    }

    const geom = traceRes.orbitLine.geometry as THREE.BufferGeometry;
    geom.setDrawRange(0, totalPoints);
    (geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;

    // Position the orbital waypoint marker at the final point (t = targetMs) and draw the nadir line to the acquisition center
    const lastIdx3 = numSteps * 3;
    const endOrbitX = traceRes.orbitPositions[lastIdx3];
    const endOrbitY = traceRes.orbitPositions[lastIdx3 + 1];
    const endOrbitZ = traceRes.orbitPositions[lastIdx3 + 2];

    traceRes.futureSatMesh.position.set(endOrbitX, endOrbitY, endOrbitZ);
    traceRes.futureSatMat.uniforms.uColor.value.copy(baseColor);

    const targetSurfaceVec = latLngToUnitVector(
      activeAcq.center_latitude_deg,
      activeAcq.center_longitude_deg
    ).multiplyScalar(surfaceTargetRadius);

    traceRes.nadirPositions[0] = endOrbitX;
    traceRes.nadirPositions[1] = endOrbitY;
    traceRes.nadirPositions[2] = endOrbitZ;
    traceRes.nadirPositions[3] = targetSurfaceVec.x;
    traceRes.nadirPositions[4] = targetSurfaceVec.y;
    traceRes.nadirPositions[5] = targetSurfaceVec.z;

    const nadirGeom = traceRes.nadirLine.geometry as THREE.BufferGeometry;
    (nadirGeom.attributes.position as THREE.BufferAttribute).needsUpdate = true;

    traceRes.group.visible = true;
  };

  const syncSatellitesToGlobe = (globe: GlobeInstance, fleet: SatelliteConfig[]) => {
    const simMs = getSimulatedTimeMsRef.current();

    // Update solar terminator position for the simulated time
    updateSunPosition(simMs);

    if (positionObjectsRef.current.length !== fleet.length) {
      positionObjectsRef.current = fleet.map((sat) => computeSatellitePosition(sat, simMs));
    } else {
      for (let i = 0; i < fleet.length; i++) {
        const nextPos = computeSatellitePosition(fleet[i], simMs);
        Object.assign(positionObjectsRef.current[i], nextPos);
        const cachedMesh = meshCacheRef.current.get(nextPos.id);
        if (cachedMesh) {
          updateSatelliteMeshColor(cachedMesh, nextPos.color);
        }
      }
    }

    const combinedObjects: GlobeSceneObject[] = [...positionObjectsRef.current];
    const activeAcq = selectedAcquisitionRef.current;
    if (
      activeAcq &&
      selectedSatelliteIdRef.current &&
      (activeAcq.status || '').toLowerCase() !== 'reprogrammed'
    ) {
      const satCfg = fleet.find((s) => s.id === activeAcq.satellite_id);
      const satColor = satCfg ? getSatelliteColor(satCfg) : '#38bdf8';
      combinedObjects.push({
        isAcquisitionTarget: true,
        id: `acq-${activeAcq.id}`,
        acquisition: activeAcq,
        color: satColor,
      });

      const cachedAcqMesh = acqMeshCacheRef.current.get(`${activeAcq.id}:${satColor}`);
      if (cachedAcqMesh) {
        updateAcquisitionTargetLabel(cachedAcqMesh, activeAcq, satColor, simMs);
      }
    }

    globe.objectsData(combinedObjects);

    // Update the 3D orbit trace from current simulated time until the planned acquisition time
    updateAcquisitionOrbitTrace(simMs, fleet, activeAcq, selectedSatelliteIdRef.current);

    // Update highlight halo visibility and subtle pulse on the selected satellite & acquisition target
    updateSelectionHalos(selectedSatelliteIdRef.current, performance.now() * 0.006);

    // If automatic satellite tracking is enabled, continuously keep the camera centered on the selected satellite
    if (trackSelectedSatelliteRef.current && selectedSatelliteIdRef.current) {
      const trackedSat = positionObjectsRef.current.find(
        (s) => s.id === selectedSatelliteIdRef.current
      );
      if (trackedSat) {
        const currentPov = globe.pointOfView();
        globe.pointOfView(
          {
            lat: trackedSat.currentLat,
            lng: trackedSat.currentLng,
            altitude: currentPov?.altitude ?? 2.15,
          },
          0
        );
      }
    }
  };

  // Initialize Globe instance once
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    // Create procedural Day & Night textures immediately, then upgrade to high-res Blue Marble Day & Night
    const fallbackDayTex = createProceduralEarthCanvasTexture('day');
    const fallbackNightTex = createProceduralEarthCanvasTexture('night');
    const initialSubsolar = computeSubsolarPoint(getSimulatedTimeMsRef.current());
    const initialSunVec = latLngToUnitVector(initialSubsolar.lat, initialSubsolar.lng);
    const dayNightShaderMaterial = createDayNightEarthShaderMaterial(
      fallbackDayTex,
      fallbackNightTex,
      initialSunVec
    );
    earthShaderMatRef.current = dayNightShaderMaterial;

    // Step 1: Instantiate Globe with waitForGlobeReady: false so scene.visible is true immediately
    const globe = new Globe(container, { waitForGlobeReady: false, animateIn: true });

    // Attach 3D orbit trace group directly to the globe scene
    const traceResources = createOrbitTraceResources();
    orbitTraceRef.current = traceResources;
    globe.scene().add(traceResources.group);

    // Step 2: Configure dimensions, custom Day/Night ShaderMaterial, atmosphere, and 3D satellites
    globe
      .width(container.clientWidth || window.innerWidth)
      .height(container.clientHeight || window.innerHeight)
      .backgroundColor('#030712')
      .globeMaterial(dayNightShaderMaterial)
      .showGraticules(true)
      .showAtmosphere(true)
      .atmosphereColor('#38bdf8')
      .atmosphereAltitude(0.22)
      // Polar-orbiting Satellite Fleet + 300x300 km Capture Coverage Footprint + Highlighted Acquisition Area
      .objectLat((d: object) =>
        isAcquisitionObject(d)
          ? d.acquisition.center_latitude_deg
          : (d as SatellitePosition).currentLat
      )
      .objectLng((d: object) =>
        isAcquisitionObject(d)
          ? d.acquisition.center_longitude_deg
          : (d as SatellitePosition).currentLng
      )
      .objectAltitude((d: object) =>
        isAcquisitionObject(d)
          ? 0.0065
          : getGlobeAltitudeRatio((d as SatellitePosition).orbit_altitude_km)
      )
      .objectFacesSurface(true)
      .objectRotation((d: object) => ({
        x: 0,
        y: 0,
        z: isAcquisitionObject(d) ? 0 : (d as SatellitePosition).headingDeg,
      }))
      .objectThreeObject((d: object) => {
        if (isAcquisitionObject(d)) {
          const key = `${d.acquisition.id}:${d.color}`;
          const nowSimMs = getSimulatedTimeMsRef.current();
          let acqMesh = acqMeshCacheRef.current.get(key);
          if (!acqMesh) {
            acqMesh = createAcquisitionTargetMesh(d.acquisition, d.color, nowSimMs);
            acqMeshCacheRef.current.set(key, acqMesh);
          } else {
            const nextStatusColor = new THREE.Color(getAcquisitionStatusColor(d.acquisition.status));
            const haloMats = acqMesh.userData.haloMaterials as
              | Array<THREE.LineBasicMaterial | THREE.MeshBasicMaterial>
              | undefined;
            if (haloMats) {
              haloMats.forEach((mat) => mat.color.copy(nextStatusColor));
            }
            updateAcquisitionTargetLabel(acqMesh, d.acquisition, d.color, nowSimMs);
          }
          return acqMesh;
        }
        const sat = d as SatellitePosition;
        let mesh = meshCacheRef.current.get(sat.id);
        if (!mesh) {
          mesh = createSatelliteAndFootprintMesh(sat);
          meshCacheRef.current.set(sat.id, mesh);
        } else {
          updateSatelliteMeshColor(mesh, sat.color);
        }
        return mesh;
      })
      .objectLabel((d: object) => {
        if (isAcquisitionObject(d)) {
          const acq = d.acquisition;
          const wKm = (acq.width_m / 1000).toFixed(1);
          const hKm = (acq.height_m / 1000).toFixed(1);
          const utcStr = new Date(acq.acquisition_timestamp)
            .toISOString()
            .replace('T', ' ')
            .slice(0, 19);
          return `
            <div style="
              background: rgba(15, 23, 42, 0.94);
              border: 1px solid ${d.color};
              border-radius: 6px;
              padding: 7px 11px;
              color: #f8fafc;
              font-family: 'JetBrains Mono', monospace;
              font-size: 11px;
            ">
              <div style="color:${d.color};font-weight:700;margin-bottom:3px;">
                ACQUISITION TARGET • ${wKm}×${hKm} km [${acq.status}]
              </div>
              <div>CENTER: ${acq.center_latitude_deg.toFixed(3)}°, ${acq.center_longitude_deg.toFixed(3)}°</div>
              <div style="color:#94a3b8;font-size:10px;margin-top:2px;">TIME: ${utcStr} UTC</div>
            </div>
          `;
        }
        const sat = d as SatellitePosition;
        const shortId = sat.id.slice(-4).toUpperCase();
        return `
          <div style="
            background: rgba(15, 23, 42, 0.92);
            border: 1px solid ${sat.color};
            border-radius: 6px;
            padding: 5px 9px;
            color: #f8fafc;
            font-family: 'JetBrains Mono', monospace;
            font-size: 11px;
          ">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${sat.color};margin-right:6px;"></span>
            SAT-${shortId} • 300×300 km Swath (Click to inspect)
          </div>
        `;
      })
      .onGlobeClick((coords: { lat: number; lng: number }) => {
        if (isPickingLocationRef.current && onPickLocationRef.current) {
          onPickLocationRef.current(coords);
        }
      })
      .onObjectClick((obj: object, _event: MouseEvent, coords: { lat: number; lng: number }) => {
        if (isPickingLocationRef.current && onPickLocationRef.current) {
          if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
            onPickLocationRef.current(coords);
            return;
          }
          if (isAcquisitionObject(obj)) {
            onPickLocationRef.current({
              lat: obj.acquisition.center_latitude_deg,
              lng: obj.acquisition.center_longitude_deg,
            });
            return;
          }
          const sat = obj as SatellitePosition;
          onPickLocationRef.current({ lat: sat.currentLat, lng: sat.currentLng });
          return;
        }
        if (isAcquisitionObject(obj)) return;
        const sat = obj as SatellitePosition;
        onSelectSatelliteRef.current(sat);
      });

    // Asynchronously load high-res NASA Blue Marble Day & Night textures and swap into the shader uniforms
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg', (dayTex) => {
      if (earthShaderMatRef.current) {
        earthShaderMatRef.current.uniforms.dayTexture.value = dayTex;
        earthShaderMatRef.current.needsUpdate = true;
      }
    });
    loader.load('https://unpkg.com/three-globe/example/img/earth-night.jpg', (nightTex) => {
      if (earthShaderMatRef.current) {
        earthShaderMatRef.current.uniforms.nightTexture.value = nightTex;
        earthShaderMatRef.current.needsUpdate = true;
      }
    });

    // Configure OrbitControls
    const controls = globe.controls();
    if (controls) {
      controls.enableDamping = true;
      controls.dampingFactor = 0.07;
      controls.rotateSpeed = 0.75;
      controls.zoomSpeed = 0.9;
      controls.minDistance = 108;
      controls.maxDistance = 650;
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.55;
    }

    // Set initial camera perspective
    globe.pointOfView({ lat: 24, lng: 12, altitude: 2.15 }, 0);

    // Sync satellites that already arrived before mount finished
    syncSatellitesToGlobe(globe, satellitesRef.current);

    // Real-time / accelerated orbital & solar terminator propagation loop (~20 FPS)
    const orbitTimer = window.setInterval(() => {
      if (globeRef.current) {
        syncSatellitesToGlobe(globeRef.current, satellitesRef.current);
      }
    }, 50);

    // Handle responsive resize
    const handleResize = () => {
      if (!containerRef.current || !globeRef.current) return;
      globeRef.current
        .width(containerRef.current.clientWidth || window.innerWidth)
        .height(containerRef.current.clientHeight || window.innerHeight);
    };

    window.addEventListener('resize', handleResize);
    globeRef.current = globe;

    return () => {
      window.clearInterval(orbitTimer);
      window.removeEventListener('resize', handleResize);
      globeRef.current = null;
      earthShaderMatRef.current = null;
      orbitTraceRef.current = null;
      meshCacheRef.current.clear();
      acqMeshCacheRef.current.clear();
      if (container) {
        container.innerHTML = '';
      }
    };
  }, []);

  // Update autoRotate dynamically (pause orbit auto-rotation while actively tracking a satellite)
  useEffect(() => {
    if (!globeRef.current) return;
    const controls = globeRef.current.controls();
    if (controls) {
      controls.autoRotate = autoRotate && !(trackSelectedSatellite && Boolean(selectedSatelliteId));
    }
  }, [autoRotate, trackSelectedSatellite, selectedSatelliteId]);

  // Update highlight halo when selectedSatelliteId changes; only center on satellite if no acquisition is active or tracking is enabled
  useEffect(() => {
    updateSelectionHalos(selectedSatelliteId, performance.now() * 0.006);

    if (!globeRef.current || !selectedSatelliteId) return;
    if (!trackSelectedSatelliteRef.current && selectedAcquisitionRef.current) {
      // Camera move & zoom is handled by the selectedAcquisition effect below
      return;
    }

    const satCfg = satellitesRef.current.find((s) => s.id === selectedSatelliteId);
    if (!satCfg) return;

    const satPos = computeSatellitePosition(satCfg, getSimulatedTimeMsRef.current());
    const currentPov = globeRef.current.pointOfView();
    globeRef.current.pointOfView(
      {
        lat: satPos.currentLat,
        lng: satPos.currentLng,
        altitude: currentPov?.altitude ?? 2.15,
      },
      900
    );
  }, [selectedSatelliteId]);

  // Sync acquisition target + orbit trace, and if satellite tracking is disabled, move camera and zoom over the acquisition area
  useEffect(() => {
    if (!globeRef.current) return;
    syncSatellitesToGlobe(globeRef.current, satellitesRef.current);

    if (selectedAcquisition && !trackSelectedSatelliteRef.current) {
      onFocusAcquisitionRef.current?.();
      globeRef.current.pointOfView(
        {
          lat: selectedAcquisition.center_latitude_deg,
          lng: selectedAcquisition.center_longitude_deg,
          altitude: 0.55,
        },
        1000
      );
    }
  }, [selectedAcquisition, acquisitionFocusKey]);

  // Sync satellite fleet immediately when loaded
  useEffect(() => {
    if (!globeRef.current) return;
    syncSatellitesToGlobe(globeRef.current, satellites);
  }, [satellites]);

  return (
    <div
      ref={containerRef}
      className={`globe-canvas-container ${isPickingLocation ? 'picking-location' : ''}`}
      aria-label="Interactive 3D Earth Telemetry Globe"
    />
  );
};
