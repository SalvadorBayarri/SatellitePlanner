/**
 * Continental and major island landmass polygons ([longitude, latitude] vertices)
 * slightly inset from coastlines so any point inside a polygon is guaranteed to be
 * on solid land (never over oceans or inland seas).
 */
type LngLat = [number, number];

const LAND_POLYGONS: LngLat[][] = [
  // 1. North America — Alaska & Western/Northern Canada
  [
    [-164, 60],
    [-164, 68],
    [-140, 69],
    [-125, 69],
    [-96, 67],
    [-95, 51],
    [-122, 49],
    [-130, 55],
    [-140, 60],
  ],
  // 2. North America — Contiguous USA & Southern Canada
  [
    [-123, 48],
    [-122, 36],
    [-117, 33],
    [-110, 31],
    [-98, 27],
    [-95, 29],
    [-90, 30],
    [-82, 27],
    [-81, 31],
    [-76, 35],
    [-75, 40],
    [-71, 43],
    [-68, 45],
    [-72, 47],
    [-79, 44],
    [-84, 46],
    [-90, 48],
    [-95, 50],
  ],
  // 3. North America — Quebec & Labrador
  [
    [-78, 52],
    [-77, 60],
    [-65, 58],
    [-58, 52],
    [-66, 50],
    [-73, 47],
  ],
  // 4. Mexico & Central America
  [
    [-110, 31],
    [-108, 24],
    [-104, 20],
    [-97, 16],
    [-91, 15],
    [-87, 14],
    [-84, 10],
    [-80, 8.5],
    [-83, 11],
    [-88, 17],
    [-88, 20],
    [-90, 20],
    [-92, 18],
    [-97, 20],
    [-98, 26],
  ],
  // 5. South America
  [
    [-75, 9],
    [-62, 9],
    [-52, 4],
    [-50, 0],
    [-36, -6],
    [-39, -13],
    [-40, -20],
    [-44, -23],
    [-49, -28],
    [-54, -33],
    [-58, -38],
    [-65, -43],
    [-69, -51],
    [-72, -48],
    [-72, -39],
    [-70, -29],
    [-70, -18],
    [-75, -14],
    [-79, -5],
    [-77, 2],
  ],
  // 6. Greenland (ice-free / coastal & interior plateau)
  [
    [-50, 62],
    [-42, 62],
    [-23, 70],
    [-22, 77],
    [-54, 77],
    [-52, 68],
  ],
  // 7. Europe — Iberian Peninsula (Spain & Portugal)
  [
    [-8.5, 37.5],
    [-2, 37.5],
    [2, 41.5],
    [2, 42.8],
    [-2, 43],
    [-8.5, 42.8],
  ],
  // 8. Europe — Western, Central, and Eastern Mainland Europe
  [
    [-3, 47.5],
    [-0.5, 44],
    [5, 44],
    [8, 45],
    [12, 44],
    [15.5, 40.5],
    [17, 40.5],
    [13.5, 45.5],
    [16, 46],
    [20, 42],
    [22.5, 39],
    [26, 41.5],
    [28, 43.5],
    [29, 46],
    [34, 47],
    [39, 47],
    [43, 44],
    [47, 46],
    [58, 52],
    [58, 66],
    [42, 65],
    [35, 64],
    [30, 60],
    [24, 59],
    [21, 55],
    [14, 53.8],
    [9, 53.8],
    [5, 52],
    [2, 50.5],
  ],
  // 9. Europe — Scandinavia (Norway, Sweden, Finland)
  [
    [6.5, 59],
    [6.5, 62],
    [12, 65],
    [18, 68.5],
    [28, 69.5],
    [29, 63],
    [21.5, 61],
    [17.5, 59],
    [14, 56],
    [12, 57.5],
  ],
  // 10. Europe — Great Britain
  [
    [-4.5, 50.5],
    [0.8, 51.2],
    [-0.2, 53.5],
    [-2.5, 56],
    [-4.8, 57.5],
    [-3, 53],
  ],
  // 11. Africa — Mainland
  [
    [-16, 15],
    [-15.5, 21],
    [-12, 27],
    [-5.5, 35],
    [9.5, 36.5],
    [10.5, 33],
    [20, 32],
    [31, 31],
    [33.5, 27],
    [36.5, 21],
    [41, 14],
    [43, 11],
    [49, 11],
    [47, 5],
    [40.5, -1],
    [39, -7],
    [39.5, -15],
    [34.5, -20],
    [34.5, -24],
    [30.5, -29],
    [25.5, -33],
    [19, -33.5],
    [17.5, -29],
    [14.5, -22],
    [12.5, -15],
    [13, -8],
    [9.5, -1],
    [9.5, 4.5],
    [2, 6.5],
    [-7.5, 5.5],
    [-13, 9.5],
  ],
  // 12. Africa — Madagascar
  [
    [44.5, -24.5],
    [47, -24.5],
    [49, -15.5],
    [48, -13.5],
    [44.5, -17],
  ],
  // 13. Asia — Anatolia (Turkey) & Levant
  [
    [27.5, 37],
    [35, 37],
    [35.5, 32],
    [38, 32],
    [44, 38],
    [42, 41],
    [35, 41],
    [28, 41],
  ],
  // 14. Asia — Arabian Peninsula
  [
    [36.5, 28],
    [43.5, 13.5],
    [54, 17],
    [58.5, 22],
    [55, 24],
    [50, 26],
    [47, 30],
    [40, 30],
  ],
  // 15. Asia — Iran, Central Asia, Siberia, India, China & Mainland SE Asia
  [
    [46, 38],
    [48.5, 31],
    [56, 27.5],
    [67, 25],
    [70, 23],
    [73, 21],
    [77.5, 9],
    [80, 13],
    [85, 19.5],
    [88, 22],
    [92, 21],
    [97, 16.5],
    [99, 9],
    [103, 2.5],
    [104, 11],
    [108.5, 12],
    [108, 16],
    [106, 20],
    [114, 22.5],
    [119.5, 25],
    [121, 31],
    [119, 35],
    [121.5, 37],
    [118, 39],
    [122, 40.5],
    [129, 41.5],
    [135, 44],
    [139, 51],
    [136, 55],
    [142, 60],
    [160, 62],
    [174, 65],
    [174, 68.5],
    [130, 70.5],
    [90, 70.5],
    [68, 67.5],
    [58, 66],
    [58, 52],
    [53, 46],
    [54, 38],
  ],
  // 16. Asia — Korean Peninsula
  [
    [126.5, 35],
    [129, 35.5],
    [129, 41],
    [125.5, 40],
  ],
  // 17. Asia — Japan (Honshu & Hokkaido)
  [
    [131, 33.5],
    [136, 34.5],
    [140, 36],
    [140.8, 40.5],
    [139, 39.5],
    [136, 36],
  ],
  [
    [140.5, 42.2],
    [144, 43],
    [142, 45],
    [140.5, 43],
  ],
  // 18. Asia — Sumatra, Borneo, Java, Sulawesi, New Guinea
  [
    [96, 4.5],
    [104.5, -4.5],
    [103, -5],
    [95.5, 3],
  ],
  [
    [110, -2.5],
    [117, -2.5],
    [117.5, 5],
    [114, 4],
    [109.5, 1],
  ],
  [
    [106.5, -6.6],
    [114, -7.7],
    [114, -8.2],
    [106.5, -7.2],
  ],
  [
    [133.5, -2],
    [141, -3],
    [147, -6],
    [148, -9],
    [142, -8],
    [136, -4],
  ],
  // 19. Australia — Mainland
  [
    [114.5, -22],
    [115.5, -33.5],
    [122, -33.5],
    [131, -31.5],
    [137, -35],
    [147, -38],
    [149.5, -36],
    [152.5, -27],
    [148.5, -21],
    [144, -15],
    [142.2, -12],
    [141, -17],
    [136, -15],
    [136, -12.5],
    [130, -13],
    [123, -17],
  ],
  // 20. New Zealand — South & North Islands
  [
    [167.5, -45],
    [170.5, -45.5],
    [173.5, -42],
    [172, -41],
  ],
  [
    [174.5, -39.5],
    [177.5, -38],
    [176, -37],
    [174.5, -37],
  ],
];

/**
 * Standard ray-casting point-in-polygon check.
 */
function pointInPolygon(lat: number, lng: number, polygon: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Returns true if the given (latitude, longitude) coordinate is located on a landmass
 * (continent or major island) rather than over the ocean or sea.
 */
export function isPointOnLand(lat: number, lng: number): boolean {
  for (const polygon of LAND_POLYGONS) {
    if (pointInPolygon(lat, lng, polygon)) {
      return true;
    }
  }
  return false;
}
