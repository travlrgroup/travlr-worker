// TRAVLR Price Comparison Worker v4.4.0
// Sources:
//   Agoda    — Affiliate Lite API v2 (direct, real prices, geo search)
//   Booking  — booking-com15.p.rapidapi.com (RapidAPI, name search)
//   Expedia  — Expedia Rapid API v3 (direct, real prices, geo search)
//
// Secrets required (set via wrangler secret put):
//   AGODA_API_KEY       = "1966074:<key>"
//   RAPIDAPI_KEY        = RapidAPI key for booking-com15
//   EXPEDIA_API_KEY     = "6et1fpoohvst2hia477rrjutrr"
//   EXPEDIA_API_SECRET  = "34nhge23111i6"
//   EXPEDIA_CID         = "506148"
//   ALLOWED_ORIGINS     = "*" or comma-separated list
//
// KV Bindings required (set in wrangler.toml):
//   RATE_CACHE    — 15-minute response cache keyed by request params
//   ANALYTICS     — per-impression event log (hotel, OTAs, prices, savings)
//
// Changes in v4.4.0:
//   - KV caching: 15-minute TTL on /rates responses — cuts API costs, ~100ms hits
//   - FX conversion: all OTA prices normalised to requested currency via exchangerate-api
//   - Analytics: every impression logged to KV with hotel, OTA prices, savings, partner
//   - Updated Expedia credentials (PROD key)
//   - lat/lng still optional (geocoding fallback from v4.3.0 retained)

var WORKER_VERSION = "4.4.0";
var CACHE_TTL_SECONDS = 900; // 15 minutes
var FX_CACHE_TTL_SECONDS = 3600; // 1 hour for FX rates

// ─── CORS ─────────────────────────────────────────────────────────────────────
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
  const isAllowed = allowed.includes("*") || allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": isAllowed ? origin || "*" : allowed[0] || "null",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Partner-ID",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function jsonResponse(data, status, origin, env, cached) {
  const headers = {
    "Content-Type": "application/json",
    "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    "X-Cache": cached ? "HIT" : "MISS",
    ...corsHeaders(origin || "*", env || {})
  };
  return new Response(JSON.stringify(data), { status: status || 200, headers });
}

function getNights(checkIn, checkOut) {
  const ms = new Date(checkOut) - new Date(checkIn);
  return ms > 0 ? Math.round(ms / 86400000) : 1;
}

function fuzzyMatch(name, query) {
  if (!name || !query) return 0;
  const n = name.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (!words.length) return 0;
  return words.filter(w => n.includes(w)).length / words.length;
}

// ─── FX CONVERSION ────────────────────────────────────────────────────────────
// Uses exchangerate-api.com open endpoint (no key needed, free tier).
// Caches rates in KV for 1 hour to avoid hammering the API.
async function getFxRates(baseCurrency, targetCurrency, kv) {
  if (baseCurrency === targetCurrency) return 1.0;

  const cacheKey = `fx:${baseCurrency}:${targetCurrency}`;
  if (kv) {
    const cached = await kv.get(cacheKey);
    if (cached) return parseFloat(cached);
  }

  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${baseCurrency}`);
    if (!res.ok) return 1.0;
    const data = await res.json();
    const rate = data.rates?.[targetCurrency];
    if (!rate) return 1.0;

    if (kv) {
      await kv.put(cacheKey, String(rate), { expirationTtl: FX_CACHE_TTL_SECONDS });
    }
    return rate;
  } catch (e) {
    console.log("FX error:", e.message);
    return 1.0;
  }
}

async function convertPrice(amount, fromCurrency, toCurrency, kv) {
  if (!amount || fromCurrency === toCurrency) return amount;
  const rate = await getFxRates(fromCurrency, toCurrency, kv);
  return Math.round(amount * rate);
}

// ─── GEOCODE ──────────────────────────────────────────────────────────────────
async function geocodeHotel(hotelName) {
  if (!hotelName) return null;
  try {
    const qs = new URLSearchParams({ q: hotelName, format: "json", limit: "1", addressdetails: "0" });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, {
      headers: { "User-Agent": "TRAVLR-Widget/4.4.0 (travlr.com)" }
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch (e) {
    console.log("Geocode error:", e.message);
    return null;
  }
}

// ─── ANALYTICS ────────────────────────────────────────────────────────────────
// Logs each widget impression to KV. Key: analytics:{timestamp}:{hotelCode}
// Value: JSON event with hotel, rates, savings, partner, currency.
// Non-blocking — fires and forgets, never delays the response.
async function logImpression(data, kv) {
  if (!kv) return;
  try {
    const key = `analytics:${Date.now()}:${data.hotelCode || data.hotelSlug || "unknown"}`;
    const event = {
      ts: new Date().toISOString(),
      hotelCode: data.hotelCode,
      hotelSlug: data.hotelSlug,
      hotelName: data.hotelName,
      checkIn: data.checkIn,
      checkOut: data.checkOut,
      nights: data.nights,
      currency: data.currency,
      travlrPrice: data.travlrPrice,
      savings: data.savings,
      rateCount: data.rateCount,
      activeOtas: data.meta?.activeOtas || [],
      rates: (data.rates || []).map(r => ({ ota: r.ota, totalPrice: r.totalPrice, currency: r.currency })),
      partnerId: data.partnerId,
      version: WORKER_VERSION
    };
    // TTL: 90 days — enough for trend analysis without unbounded growth
    await kv.put(key, JSON.stringify(event), { expirationTtl: 90 * 24 * 3600 });
  } catch (e) {
    console.log("Analytics log error:", e.message);
  }
}

// ─── AGODA ────────────────────────────────────────────────────────────────────
async function fetchAgoda(params, key, kv) {
  const { hotelName, lat, lng, checkIn, checkOut, adults, currency, nights } = params;
  if (!key || !lat || !lng) return null;

  try {
    const body = {
      criteria: {
        additional: {
          currency,
          occupancy: { numberOfAdult: adults, numberOfChildren: 0 },
          priceType: "PerRoom"
        },
        checkInDate: checkIn,
        checkOutDate: checkOut,
        geo: { latitude: lat, longitude: lng, searchRadius: 3 }
      }
    };

    const res = await fetch("https://affiliateapi7643.agoda.com/affiliateservice/lt_v1", {
      method: "POST",
      headers: { "Authorization": key, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.log(`Agoda ${res.status}: ${await res.text().then(t => t.slice(0, 100))}`);
      return null;
    }

    const data = await res.json();
    const hotels = data.results || data.result?.hotels || [];
    if (!hotels.length) return null;

    let best = hotels[0], bestScore = 0;
    for (const h of hotels) {
      const score = fuzzyMatch(h.hotelName || "", hotelName);
      if (score > bestScore) { bestScore = score; best = h; }
    }

    if (!best.dailyRate) return null;

    const otaCurrency = best.currency || currency;
    const rawTotal = Math.round(best.dailyRate * nights);
    const convertedTotal = await convertPrice(rawTotal, otaCurrency, currency, kv);
    const convertedPerNight = Math.round(convertedTotal / nights);

    return {
      ota: "agoda",
      name: "Agoda",
      pricePerNight: convertedPerNight,
      totalPrice: convertedTotal,
      currency,
      originalCurrency: otaCurrency !== currency ? otaCurrency : undefined,
      bookingUrl: best.landingURL || `https://www.agoda.com/partners/partnersearch.aspx?cid=1807881&hid=${best.hotelId}&currency=${currency}&checkin=${checkIn}&checkout=${checkOut}&NumberofAdults=${adults}&NumberofChildren=0&Rooms=1`,
      hotelName: best.hotelName
    };
  } catch (e) {
    console.log("Agoda error:", e.message);
    return null;
  }
}

// ─── BOOKING.COM ──────────────────────────────────────────────────────────────
async function fetchBooking(params, rapidApiKey, kv) {
  const { hotelName, checkIn, checkOut, adults, currency, nights } = params;
  if (!rapidApiKey) return null;

  try {
    const HOST = "booking-com15.p.rapidapi.com";

    const destRes = await fetch(
      `https://${HOST}/api/v1/hotels/searchDestination?query=${encodeURIComponent(hotelName)}`,
      { headers: { "X-RapidAPI-Key": rapidApiKey, "X-RapidAPI-Host": HOST } }
    );
    if (!destRes.ok) { console.log(`Booking dest ${destRes.status}`); return null; }

    const destData = await destRes.json();
    const destinations = destData.data || [];
    const hotelDest = destinations.find(d => d.dest_type === "hotel") || destinations[0];
    if (!hotelDest) return null;

    const searchQs = new URLSearchParams({
      dest_id: hotelDest.dest_id,
      search_type: hotelDest.dest_type || "city",
      arrival_date: checkIn,
      departure_date: checkOut,
      adults: String(adults),
      room_qty: "1",
      currency_code: currency,
      languagecode: "en-us",
      units: "metric",
      page_number: "1",
      temperature_unit: "c"
    });

    const hotelsRes = await fetch(
      `https://${HOST}/api/v1/hotels/searchHotels?${searchQs}`,
      { headers: { "X-RapidAPI-Key": rapidApiKey, "X-RapidAPI-Host": HOST } }
    );
    if (!hotelsRes.ok) { console.log(`Booking search ${hotelsRes.status}`); return null; }

    const hotelsData = await hotelsRes.json();
    const hotels = hotelsData.data?.hotels || [];
    if (!hotels.length) return null;

    let best = hotels[0], bestScore = 0;
    for (const h of hotels) {
      const score = fuzzyMatch(h.property?.name || "", hotelName);
      if (score > bestScore) { bestScore = score; best = h; }
    }

    const grossPrice = best.property?.priceBreakdown?.grossPrice;
    const rawTotal = grossPrice?.value;
    if (!rawTotal) return null;

    const otaCurrency = grossPrice?.currency || currency;
    const convertedTotal = await convertPrice(Math.round(rawTotal), otaCurrency, currency, kv);

    const countryCode = best.property?.countryCode?.toLowerCase() || "";
    const bookingUrl = `https://www.booking.com/hotel/${countryCode}/${best.property?.id}.html?checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=1&currency=${currency}`;

    return {
      ota: "booking",
      name: "Booking.com",
      pricePerNight: Math.round(convertedTotal / nights),
      totalPrice: convertedTotal,
      currency,
      originalCurrency: otaCurrency !== currency ? otaCurrency : undefined,
      bookingUrl,
      hotelName: best.property?.name
    };
  } catch (e) {
    console.log("Booking error:", e.message);
    return null;
  }
}

// ─── EXPEDIA ──────────────────────────────────────────────────────────────────
async function fetchExpedia(params, apiKey, apiSecret, cid, kv) {
  const { hotelName, lat, lng, checkIn, checkOut, adults, currency, nights } = params;
  if (!apiKey || !apiSecret || !lat || !lng) return null;

  try {
    const ts = Math.floor(Date.now() / 1000);
    const msgBuf = new TextEncoder().encode(`${apiKey}${apiSecret}${ts}`);
    const hashBuf = await crypto.subtle.digest("SHA-512", msgBuf);
    const sig = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    const authHeader = `EAN apikey=${apiKey},signature=${sig},timestamp=${ts}`;

    const searchQs = new URLSearchParams({
      language: "en-US",
      supply_source: "expedia",
      checkin: checkIn,
      checkout: checkOut,
      occupancy: `${adults}`,
      currency,
      country_code: "AU",
      sales_channel: "website",
      sales_environment: "hotel_only",
      sort_type: "preferred",
      limit: "10",
      latitude: String(lat),
      longitude: String(lng),
      radius: "3",
      unit: "km"
    });

    const res = await fetch(`https://api.ean.com/v3/properties/availability?${searchQs}`, {
      headers: {
        "Authorization": authHeader,
        "Accept": "application/json",
        "Partner-Transaction-Id": `travlr-${Date.now()}`
      }
    });

    if (!res.ok) {
      console.log(`Expedia ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
      return null;
    }

    const properties = await res.json();
    if (!Array.isArray(properties) || !properties.length) return null;

    let best = properties[0], bestScore = 0;
    for (const p of properties) {
      const score = fuzzyMatch(p.property?.name || "", hotelName);
      if (score > bestScore) { bestScore = score; best = p; }
    }

    const room = best.rooms?.[0];
    const rate = room?.rates?.[0];
    const pricing = rate?.occupancy_pricing?.[`${adults}`];
    const rawTotal = pricing?.totals?.inclusive?.billable_currency?.value
      || pricing?.totals?.gross?.value;
    if (!rawTotal) return null;

    const otaCurrency = pricing?.totals?.inclusive?.billable_currency?.currency || currency;
    const convertedTotal = await convertPrice(Math.round(parseFloat(rawTotal)), otaCurrency, currency, kv);

    const propId = best.property?.id;
    const affiliateCid = cid || "506148";
    const bookingUrl = `https://www.expedia.com/h${propId}.Hotel-Information?chkin=${checkIn}&chkout=${checkOut}&rm1=a${adults}&mcicid=${affiliateCid}`;

    return {
      ota: "expedia",
      name: "Expedia",
      pricePerNight: Math.round(convertedTotal / nights),
      totalPrice: convertedTotal,
      currency,
      originalCurrency: otaCurrency !== currency ? otaCurrency : undefined,
      bookingUrl,
      hotelName: best.property?.name
    };
  } catch (e) {
    console.log("Expedia error:", e.message);
    return null;
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
async function handleRates(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "*";
  const p = url.searchParams;

  const hotelCode = p.get("hotelId") || p.get("hotelCode") || "";
  const hotelSlug = p.get("hotelSlug") || "";
  const hotelName = p.get("hotelName")
    || (hotelSlug ? hotelSlug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : `Hotel ${hotelCode}`);
  const checkIn = p.get("checkIn") || "";
  const checkOut = p.get("checkOut") || "";
  const currency = (p.get("currency") || "AUD").toUpperCase();
  const adults = parseInt(p.get("adults") || "2", 10);
  const travlrPrice = p.get("travlrPrice") ? parseFloat(p.get("travlrPrice")) : null;
  const partnerId = p.get("partnerId") || p.get("data-partner-id") || "unknown";

  let lat = parseFloat(p.get("lat") || "0") || null;
  let lng = parseFloat(p.get("lng") || "0") || null;

  if (!checkIn || !checkOut) {
    return jsonResponse({ error: "checkIn and checkOut are required" }, 400, origin, env);
  }

  // ── KV Cache check ──────────────────────────────────────────────────────────
  const cacheKey = `rates:${hotelCode || hotelSlug}:${checkIn}:${checkOut}:${adults}:${currency}:${lat || ""}:${lng || ""}`;
  const rateCache = env.RATE_CACHE;

  if (rateCache) {
    const cached = await rateCache.get(cacheKey);
    if (cached) {
      const data = JSON.parse(cached);
      data.meta.cached = true;
      data.meta.cacheKey = cacheKey;
      return jsonResponse(data, 200, origin, env, true);
    }
  }

  // ── Geocode if no lat/lng ───────────────────────────────────────────────────
  let geocoded = false;
  if (!lat || !lng) {
    const geo = await geocodeHotel(hotelName);
    if (geo) {
      lat = geo.lat;
      lng = geo.lng;
      geocoded = true;
      console.log(`Geocoded "${hotelName}" → ${lat}, ${lng}`);
    } else {
      console.log(`Could not geocode "${hotelName}" — geo-based OTAs skipped`);
    }
  }

  const nights = getNights(checkIn, checkOut);
  const params = { hotelName, hotelCode, lat, lng, checkIn, checkOut, adults, currency, nights };
  const analyticsKv = env.ANALYTICS;

  // ── Parallel OTA fetch ──────────────────────────────────────────────────────
  const [agodaResult, bookingResult, expediaResult] = await Promise.allSettled([
    fetchAgoda(params, env.AGODA_API_KEY, rateCache),
    fetchBooking(params, env.RAPIDAPI_KEY, rateCache),
    fetchExpedia(params, env.EXPEDIA_API_KEY, env.EXPEDIA_API_SECRET, env.EXPEDIA_CID, rateCache)
  ]);

  const rates = [
    agodaResult.status === "fulfilled" ? agodaResult.value : null,
    bookingResult.status === "fulfilled" ? bookingResult.value : null,
    expediaResult.status === "fulfilled" ? expediaResult.value : null
  ].filter(Boolean);

  const cheapestOta = rates.length ? Math.min(...rates.map(r => r.totalPrice)) : null;
  const savings = travlrPrice && cheapestOta && cheapestOta > travlrPrice
    ? Math.round(cheapestOta - travlrPrice) : 0;

  const responseData = {
    hotelCode,
    hotelSlug,
    hotelName,
    checkIn,
    checkOut,
    nights,
    adults,
    currency,
    travlrPrice,
    savings,
    rates,
    rateCount: rates.length,
    meta: {
      version: WORKER_VERSION,
      timestamp: new Date().toISOString(),
      source: "Direct OTA APIs",
      otas: ["agoda", "booking", "expedia"],
      activeOtas: rates.map(r => r.ota),
      geocoded,
      cached: false
    }
  };

  // ── Cache the response ──────────────────────────────────────────────────────
  if (rateCache && rates.length > 0) {
    await rateCache.put(cacheKey, JSON.stringify(responseData), { expirationTtl: CACHE_TTL_SECONDS });
  }

  // ── Log analytics (non-blocking) ────────────────────────────────────────────
  if (analyticsKv) {
    const analyticsData = { ...responseData, partnerId };
    logImpression(analyticsData, analyticsKv); // intentionally not awaited
  }

  return jsonResponse(responseData, 200, origin, env, false);
}

// ─── ANALYTICS QUERY HANDLER ──────────────────────────────────────────────────
// GET /analytics?limit=100&partner=playtravel&from=2026-05-01
// Returns recent impression events for dashboard use.
async function handleAnalytics(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "*";
  const kv = env.ANALYTICS;

  if (!kv) {
    return jsonResponse({ error: "Analytics not configured" }, 503, origin, env);
  }

  const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
  const partnerFilter = url.searchParams.get("partner") || null;

  try {
    const list = await kv.list({ prefix: "analytics:", limit });
    const keys = list.keys || [];

    const events = await Promise.all(
      keys.map(async k => {
        const val = await kv.get(k.name);
        return val ? JSON.parse(val) : null;
      })
    );

    const filtered = events
      .filter(Boolean)
      .filter(e => !partnerFilter || e.partnerId === partnerFilter)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));

    // Summary stats
    const totalImpressions = filtered.length;
    const avgSavings = filtered.length
      ? Math.round(filtered.reduce((s, e) => s + (e.savings || 0), 0) / filtered.length)
      : 0;
    const otaCounts = {};
    filtered.forEach(e => (e.activeOtas || []).forEach(ota => { otaCounts[ota] = (otaCounts[ota] || 0) + 1; }));

    return jsonResponse({
      summary: { totalImpressions, avgSavings, otaCounts },
      events: filtered
    }, 200, origin, env);
  } catch (e) {
    console.log("Analytics query error:", e.message);
    return jsonResponse({ error: "Analytics query failed" }, 500, origin, env);
  }
}

// ─── FETCH HANDLER ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin, env);
    }

    switch (url.pathname) {
      case "/rates":
        return handleRates(request, env);
      case "/analytics":
        return handleAnalytics(request, env);
      case "/health":
        return jsonResponse({
          status: "ok",
          version: WORKER_VERSION,
          dataSource: "Agoda Affiliate Lite API + Booking.com RapidAPI + Expedia Rapid API",
          features: ["kv-caching", "fx-conversion", "analytics-logging"],
          cacheTtl: `${CACHE_TTL_SECONDS}s`,
          pricing: "All prices converted to requested currency. Total stay, apples to apples.",
          timestamp: new Date().toISOString()
        }, 200, origin, env);
      default:
        return jsonResponse({ error: "Not found", endpoints: ["/rates", "/analytics", "/health"] }, 404, origin, env);
    }
  }
};
