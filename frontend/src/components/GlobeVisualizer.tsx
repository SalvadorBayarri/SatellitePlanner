import React, { useEffect, useRef } from 'react';
import Globe, { GlobeInstance } from 'globe.gl';
import * as THREE from 'three';
import { GeoEvent } from '../services/api';

interface GlobeVisualizerProps {
  events: GeoEvent[];
  selectedEvent: GeoEvent | null;
  onSelectEvent: (event: GeoEvent) => void;
  autoRotate: boolean;
}

function getIntensityColor(intensity: number): string {
  if (intensity >= 0.9) return '#f43f5e'; // Rose / Critical
  if (intensity >= 0.8) return '#f59e0b'; // Amber / High
  if (intensity >= 0.7) return '#06b6d4'; // Cyan / Elevated
  return '#10b981'; // Emerald / Nominal
}

/**
 * Generates an instant, self-contained high-resolution procedural Earth texture data URL
 * so the 3D globe renders immediately in 100% offline/air-gapped or CDN-blocked environments,
 * while optionally upgrading to satellite imagery if available.
 */
function createProceduralEarthTexture(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Deep ocean gradient
  const oceanGrad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  oceanGrad.addColorStop(0, '#071426');
  oceanGrad.addColorStop(0.2, '#0a2240');
  oceanGrad.addColorStop(0.5, '#0c2d54');
  oceanGrad.addColorStop(0.8, '#0a2240');
  oceanGrad.addColorStop(1, '#071426');
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Subtle lat/lng telemetry grid lines on the sphere
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
  ctx.lineWidth = 1.5;

  // Longitude meridians (every 15 deg)
  for (let lon = -180; lon <= 180; lon += 15) {
    const x = ((lon + 180) / 360) * canvas.width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  // Latitude parallels (every 15 deg)
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * canvas.height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  // Equator highlight
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height / 2);
  ctx.lineTo(canvas.width, canvas.height / 2);
  ctx.stroke();

  // Simplified stylized continental landmasses (equirectangular projection)
  const continents: Array<Array<[number, number]>> = [
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

  ctx.fillStyle = 'rgba(14, 116, 144, 0.52)';
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
  ctx.lineWidth = 2;

  for (const poly of continents) {
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

  return canvas.toDataURL('image/png');
}

export const GlobeVisualizer: React.FC<GlobeVisualizerProps> = ({
  events,
  selectedEvent,
  onSelectEvent,
  autoRotate,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const globeRef = useRef<GlobeInstance | null>(null);
  const eventsRef = useRef<GeoEvent[]>(events);
  const onSelectRef = useRef(onSelectEvent);

  eventsRef.current = events;
  onSelectRef.current = onSelectEvent;

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

  // Initialize Globe instance once
  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const fallbackTextureUrl = createProceduralEarthTexture();

    // Step 1: Instantiate Globe with waitForGlobeReady: false so scene.visible is true immediately
    const globe = new Globe(container, { waitForGlobeReady: false, animateIn: true });

    // Step 2: Configure dimensions, textures, atmosphere, points, rings, and arcs
    globe
      .width(container.clientWidth || window.innerWidth)
      .height(container.clientHeight || window.innerHeight)
      .backgroundColor('#030712')
      .globeImageUrl(fallbackTextureUrl)
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
        onSelectRef.current(ev);
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
      .arcAltitudeAutoScale(0.38);

    // Try upgrading to high-res Blue Marble texture if internet/CDN is reachable
    const imgProbe = new Image();
    imgProbe.crossOrigin = 'anonymous';
    imgProbe.onload = () => {
      if (globeRef.current) {
        globeRef.current
          .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
          .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png');
      }
    };
    imgProbe.src = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg';

    // Enhance material lighting so the globe is vibrant and clearly visible
    const globeMaterial = globe.globeMaterial() as THREE.MeshPhongMaterial;
    if (globeMaterial) {
      globeMaterial.bumpScale = 8;
      globeMaterial.shininess = 22;
      globeMaterial.emissive = new THREE.Color('#082f49');
      globeMaterial.emissiveIntensity = 0.25;
    }

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

    // Sync any events that already arrived before mount finished
    if (eventsRef.current.length > 0) {
      syncDataToGlobe(globe, eventsRef.current);
    }

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
      window.removeEventListener('resize', handleResize);
      globeRef.current = null;
      if (container) {
        container.innerHTML = '';
      }
    };
  }, []);

  // Update autoRotate dynamically
  useEffect(() => {
    if (!globeRef.current) return;
    const controls = globeRef.current.controls();
    if (controls) {
      controls.autoRotate = autoRotate;
    }
  }, [autoRotate]);

  // Sync events, rings, and orbital relay arcs onto the 3D globe whenever events change
  useEffect(() => {
    if (!globeRef.current) return;
    syncDataToGlobe(globeRef.current, events);
  }, [events]);

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
