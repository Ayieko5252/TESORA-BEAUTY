// Tessora Beauty — delivery distance, fees and estimated delivery time.
// Shared by the local Node server and the Netlify function, so the customer is
// quoted exactly the same price wherever the shop is running.
//
// Zero dependencies: global fetch only (Node >= 20).

const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Default charge per kilometre, in shillings. */
export const DEFAULT_PER_KM = 15;

/** Straight-line distance between two lat/lng points, in kilometres. */
export function haversineKm(from, to) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Roads are never straight. When we have no Maps key to ask, pad the
// straight-line distance so the customer is not undercharged.
const ROAD_FACTOR = 1.3;

/**
 * Road distance from the shop to a destination, in kilometres.
 * Uses Google Distance Matrix when a key is available, and falls back to a
 * padded straight-line estimate so the shop still works without one.
 * Returns { km, source: 'google' | 'estimate' }.
 */
export async function distanceFromStore(settings, dest) {
  const origin = { lat: num(settings.storeLat), lng: num(settings.storeLng) };
  if (!origin.lat || !origin.lng || !dest || !num(dest.lat) || !num(dest.lng)) return null;

  const key = process.env.GOOGLE_MAPS_SERVER_KEY || settings.mapsApiKey || '';
  if (key) {
    try {
      const url = 'https://maps.googleapis.com/maps/api/distancematrix/json'
        + `?origins=${origin.lat},${origin.lng}`
        + `&destinations=${dest.lat},${dest.lng}`
        + `&mode=driving&units=metric&key=${encodeURIComponent(key)}`;
      const res = await fetch(url);
      const data = await res.json();
      const el = data?.rows?.[0]?.elements?.[0];
      if (el?.status === 'OK' && el.distance?.value) {
        return { km: el.distance.value / 1000, source: 'google' };
      }
    } catch {
      // Fall through to the estimate — a Maps outage must not block a sale.
    }
  }
  return { km: haversineKm(origin, dest) * ROAD_FACTOR, source: 'estimate' };
}

/**
 * How long delivery should take, from how far away the customer is.
 * Returns { days, label } where `days` is the number of working days to quote.
 */
export function deliveryEstimate(km) {
  if (km === null || km === undefined || !Number.isFinite(km)) {
    return { days: 2, label: '1–2 days' };
  }
  if (km <= 5) return { days: 1, label: 'Same day or next day' };
  if (km <= 15) return { days: 2, label: '1–2 days' };
  if (km <= 40) return { days: 3, label: '2–3 days' };
  if (km <= 100) return { days: 4, label: '3–4 days' };
  if (km <= 300) return { days: 5, label: '4–5 days' };
  return { days: 7, label: '5–7 days' };
}

/** The date we expect to deliver by, as an ISO date string. */
export function expectedDeliveryDate(days, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + Math.max(1, Math.round(num(days, 2))));
  return d.toISOString();
}

/**
 * Work out what a customer pays for delivery, and when it should arrive.
 *
 * Returns a full breakdown so the receipt can show its working:
 *   { fee, distanceKm, perKm, baseFee, basis, source, days, label, expectedBy }
 *
 * `basis` is one of:
 *   'free'     — the order qualified for free delivery
 *   'distance' — charged per kilometre from the shop
 *   'flat'     — no location pinned, so the flat delivery fee applies
 */
export async function quoteDelivery(settings, subtotal, dest) {
  const freeOver = num(settings.freeDeliveryOver, 0);
  const perKm = Math.max(0, num(settings.deliveryPerKm, DEFAULT_PER_KM));
  const baseFee = Math.max(0, num(settings.deliveryBaseFee, 0));

  const measured = dest ? await distanceFromStore(settings, dest) : null;
  const km = measured ? Math.round(measured.km * 10) / 10 : null;
  const eta = deliveryEstimate(km);

  const common = {
    distanceKm: km,
    perKm,
    baseFee,
    source: measured?.source || 'none',
    days: eta.days,
    label: eta.label,
    expectedBy: expectedDeliveryDate(eta.days)
  };

  // Free delivery wins over everything, but we still tell the customer how far
  // away they are and when to expect the parcel.
  if (freeOver > 0 && subtotal >= freeOver) {
    return { ...common, fee: 0, basis: 'free' };
  }
  if (km !== null) {
    return { ...common, fee: Math.max(0, Math.round(baseFee + km * perKm)), basis: 'distance' };
  }
  return { ...common, fee: Math.max(0, Math.round(num(settings.deliveryFee, 0))), basis: 'flat' };
}
