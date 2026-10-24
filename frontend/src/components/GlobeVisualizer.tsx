import React, { useEffect, useRef } from 'react';
import Globe, { GlobeInstance } from 'globe.gl';
import * as THREE from 'three';
import {
  GeoEvent,
  SatelliteConfig,
  SatellitePosition,
  computeSatellitePosition,
  computeSubsolarPoint,
  getGlobeAltitudeRatio,
} from '../services/api';

interface GlobeVisualizerProps {
  events: GeoEvent[];
  satellites: SatelliteConfig[];
  selectedEvent: GeoEvent | null;
  selectedSatelliteId: string | null;
  trackSelectedSatellite: boolean;
  onSelectEvent: (event: GeoEvent) => void;
  onSelectSatellite: (satellite: SatellitePosition) => void;
  getSimulatedTimeMs: () => number;
  autoRotate: boolean;
}

function getIntensityColor(intensity: number): string {
  if (intensity >= 0.9) return '#f43f5e'; // Rose / Critical
  if (intensity >= 0.8) return '#f59e0b'; // Amber / High
  if (intensity >= 0.7) return '#06b6d4'; // Cyan / Elevated
  return '#10b981'; // Emerald / Nominal
}

const EARTH_RADIUS_KM = 6371;
const GLOBE_RADIUS_UNITS = 100;
const FOOTPRINT_SIZE_KM = 300;
const FOOTPRINT_SIZE_UNITS = (FOOTPRINT_SIZE_KM / EARTH_RADIUS_KM) * GLOBE_RADIUS_UNITS;

// Shared geometries for satellites, footprints, and selection highlight halos
const satBodyGeom = new THREE.OctahedronGeometry(1.15, 1);
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

  // 1. Central satellite bus (colored uniquely per satellite)
  const bodyMat = new THREE.MeshPhongMaterial({
    color: baseColor,
    emissive: baseColor,
    emissiveIntensity: 0.55,
    shininess: 95,
  });
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

  return group;
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
 * Note: Raw ShaderMaterial in Three.js does not run the automatic linear-to-sRGB output pass unless included,
 * so we keep textures in default linear/raw space (no SRGBColorSpace decode) so full sRGB brightness is preserved!
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
  events,
  satellites,
  selectedEvent,
  selectedSatelliteId,
  trackSelectedSatellite,
  onSelectEvent,
  onSelectSatellite,
  getSimulatedTimeMs,
  autoRotate,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const eventsRef = useRef<GeoEvent[]>(events);
  const satellitesRef = useRef<SatelliteConfig[]>(satellites);
  const selectedSatelliteIdRef = useRef<string | null>(selectedSatelliteId);
  const trackSelectedSatelliteRef = useRef<boolean>(trackSelectedSatellite);
  const onSelectEventRef = useRef(onSelectEvent);
  const onSelectSatelliteRef = useRef(onSelectSatellite);
  const getSimulatedTimeMsRef = useRef(getSimulatedTimeMs);
  const meshCacheRef = useRef<Map<string, THREE.Group>>(new Map());
  const positionObjectsRef = useRef<SatellitePosition[]>([]);
  const earthShaderMatRef = useRef<THREE.ShaderMaterial | null>(null);

  eventsRef.current = events;
  satellitesRef.current = satellites;
  selectedSatelliteIdRef.current = selectedSatelliteId;
  trackSelectedSatelliteRef.current = trackSelectedSatellite;
  onSelectEventRef.current = onSelectEvent;
  onSelectSatelliteRef.current = onSelectSatellite;
  getSimulatedTimeMsRef.current = getSimulatedTimeMs;

  const syncDataToGlobe = (globe: GlobeInstance, currentEvents: GeoEvent[]) => {
    globe.pointsData(currentEvents);
    globe.ringsData(currentEvents.filter((e) => e.intensity >= 0.75));

    const arcs = [];
    for (let i = 0; i < Math.min(currentEvents.length - 1, 14); i++) {
      const source = currentEvents[i];
      const target = currentEvents[(i + 1) % currentEvents.length];
      arcs.push({
        startLat: source.latitude,
        startLng: source.longitude,
        endLat: target.latitude,
        endLng: target.longitude,
        color: [getIntensityColor(source.intensity), getIntensityColor(target.intensity)],
      });
    }
    globe.arcsData(arcs);
  };

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
  };

  const updateSunPosition = (simMs: number) => {
    if (!earthShaderMatRef.current) return;
    const subsolar = computeSubsolarPoint(simMs);
    const sunVec = latLngToUnitVector(subsolar.lat, subsolar.lng);
    earthShaderMatRef.current.uniforms.sunDirection.value.copy(sunVec);
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
      }
    }
    globe.objectsData(positionObjectsRef.current);

    // Update highlight halo visibility and subtle pulse on the selected satellite
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

    // Step 2: Configure dimensions, custom Day/Night ShaderMaterial, atmosphere, points, rings, arcs, and 3D satellites
    globe
      .width(container.clientWidth || window.innerWidth)
      .height(container.clientHeight || window.innerHeight)
      .backgroundColor('#030712')
      .globeMaterial(dayNightShaderMaterial)
      .showGraticules(true)
      .showAtmosphere(true)
      .atmosphereColor('#38bdf8')
      .atmosphereAltitude(0.22)
      .pointLat((d: object) => (d as GeoEvent).latitude)
      .pointLng((d: object) => (d as GeoEvent).longitude)
      .pointAltitude((d: object) => Math.max(0.08, (d as GeoEvent).intensity * 0.36))
      .pointRadius((d: object) => 0.55 + (d as GeoEvent).intensity * 0.45)
      .pointColor((d: object) => getIntensityColor((d as GeoEvent).intensity))
      .pointLabel((d: object) => {
        const ev = d as GeoEvent;
        const color = getIntensityColor(ev.intensity);
        return `
          <div style="
            background: rgba(15, 23, 42, 0.94);
            border: 1px solid ${color};
            border-radius: 8px;
            padding: 10px 14px;
            color: #f8fafc;
            font-family: 'Inter', sans-serif;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
            min-width: 210px;
          ">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: ${color}; font-weight: 700; margin-bottom: 4px;">
              SATELLITE TELEMETRY EVENT
            </div>
            <div style="font-size: 14px; font-weight: 600; margin-bottom: 6px;">
              ${ev.title}
            </div>
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #94a3b8; display: flex; justify-content: space-between;">
              <span>LAT: ${ev.latitude.toFixed(4)}°</span>
              <span>LNG: ${ev.longitude.toFixed(4)}°</span>
            </div>
            <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: #cbd5e1; margin-top: 4px;">
              INTENSITY: <strong style="color: ${color}">${(ev.intensity * 100).toFixed(0)}%</strong>
            </div>
          </div>
        `;
      })
      .onPointClick((point: object) => {
        const ev = point as GeoEvent;
        onSelectEventRef.current(ev);
      })
      .ringLat((d: object) => (d as GeoEvent).latitude)
      .ringLng((d: object) => (d as GeoEvent).longitude)
      .ringAltitude(0.015)
      .ringColor((d: object) => {
        const color = getIntensityColor((d as GeoEvent).intensity);
        return (t: number) => {
          const alpha = Math.max(0, 1 - t);
          return color === '#f43f5e'
            ? `rgba(244, 63, 94, ${alpha})`
            : color === '#f59e0b'
            ? `rgba(245, 158, 11, ${alpha})`
            : `rgba(56, 189, 248, ${alpha})`;
        };
      })
      .ringMaxRadius((d: object) => 3.0 + (d as GeoEvent).intensity * 4.5)
      .ringPropagationSpeed(2.2)
      .ringRepeatPeriod(950)
      .arcStartLat((d: any) => d.startLat)
      .arcStartLng((d: any) => d.startLng)
      .arcEndLat((d: any) => d.endLat)
      .arcEndLng((d: any) => d.endLng)
      .arcColor((d: any) => d.color)
      .arcDashLength(0.45)
      .arcDashGap(0.25)
      .arcDashAnimateTime(2200)
      .arcStroke(0.65)
      .arcAltitudeAutoScale(0.38)
      // Polar-orbiting Satellite Fleet + 300x300 km Capture Coverage Footprint + Selection Halo Layer
      .objectLat((d: object) => (d as SatellitePosition).currentLat)
      .objectLng((d: object) => (d as SatellitePosition).currentLng)
      .objectAltitude((d: object) => getGlobeAltitudeRatio((d as SatellitePosition).orbit_altitude_km))
      .objectFacesSurface(true)
      .objectRotation((d: object) => ({
        x: 0,
        y: 0,
        z: (d as SatellitePosition).headingDeg,
      }))
      .objectThreeObject((d: object) => {
        const sat = d as SatellitePosition;
        let mesh = meshCacheRef.current.get(sat.id);
        if (!mesh) {
          mesh = createSatelliteAndFootprintMesh(sat);
          meshCacheRef.current.set(sat.id, mesh);
        }
        return mesh;
      })
      .objectLabel((d: object) => {
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
      .onObjectClick((obj: object) => {
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
      controls.minDistance = 140;
      controls.maxDistance = 650;
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.55;
    }

    // Set initial camera perspective
    globe.pointOfView({ lat: 24, lng: 12, altitude: 2.15 }, 0);

    // Sync any events and satellites that already arrived before mount finished
    syncDataToGlobe(globe, eventsRef.current);
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
      meshCacheRef.current.clear();
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

  // Immediately update the highlight halo and smoothly center the globe on the selected satellite
  useEffect(() => {
    updateSelectionHalos(selectedSatelliteId, performance.now() * 0.006);

    if (!globeRef.current || !selectedSatelliteId) return;
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

  // Sync events, rings, and orbital relay arcs onto the 3D globe whenever events change
  useEffect(() => {
    if (!globeRef.current) return;
    syncDataToGlobe(globeRef.current, events);
  }, [events]);

  // Sync satellite fleet immediately when loaded
  useEffect(() => {
    if (!globeRef.current) return;
    syncSatellitesToGlobe(globeRef.current, satellites);
  }, [satellites]);

  // Smooth camera fly-to when an event is selected
  useEffect(() => {
    if (!globeRef.current || !selectedEvent) return;
    globeRef.current.pointOfView(
      {
        lat: selectedEvent.latitude,
        lng: selectedEvent.longitude,
        altitude: 1.55,
      },
      1100
    );
  }, [selectedEvent]);

  return (
    <div
      ref={containerRef}
      className="globe-canvas-container"
      aria-label="Interactive 3D Earth Telemetry Globe"
    />
  );
};
