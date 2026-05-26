// TRAVLR Price Comparison Worker v4.2.0
// Sources:
//   Agoda    — Affiliate Lite API v2 (direct, real prices)
//   Booking  — booking-com15.p.rapidapi.com (RapidAPI, real prices)
//   Expedia  — Expedia Rapid API v3 (direct, real prices, CID 506148)
//
// Secrets required:
//   AGODA_API_KEY       = "1966074:<your-agoda-api-key>"
//   RAPIDAPI_KEY        = RapidAPI key for booking-com15
//   EXPEDIA_API_KEY     = Expedia Rapid API key
//   EXPEDIA_API_SECRET  = Expedia Rapid API shared secret
//   EXPEDIA_CID         = "506148"
//   ALLOWED_ORIGINS     = "*" or comma-separated list

var WORKER_VERSION = "4.2.0";
var CACHE_TTL = 300; // 5 minutes

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

function jsonResponse(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${CACHE_TTL}`,
      ...corsHeaders(origin || "*", env || {})
    }
  });
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

// ─── AGODA ────────────────────────────────────────────────────────────────────
// Affiliate Lite API v2 — geo search, returns real prices + affiliate URLs
async function fetchAgoda(params, key) {
  const { hotelName, lat, lng, checkIn, checkOut, adults, currency, nights } = params;
  if (!key) return null;

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
      headers: {
        "Authorization": key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      console.log(`Agoda ${res.status}: ${await res.text().then(t => t.slice(0, 100))}`);
      return null;
    }

    const data = await res.json();
    const hotels = data.results || data.result?.hotels || [];
    if (!hotels.length) return null;

    // Find best match by hotel name
    let best = hotels[0];
    let bestScore = 0;
    for (const h of hotels) {
      const score = fuzzyMatch(h.hotelName || "", hotelName);
      if (score > bestScore) { bestScore = score; best = h; }
    }

    if (!best.dailyRate) return null;

    return {
      ota: "agoda",
      name: "Agoda",
      pricePerNight: Math.round(best.dailyRate),
      totalPrice: Math.round(best.dailyRate * nights),
      currency: best.currency || currency,
      bookingUrl: best.landingURL || `https://www.agoda.com/partners/partnersearch.aspx?cid=1807881&hid=${best.hotelId}`,
      hotelName: best.hotelName
    };
  } catch (e) {
    console.log("Agoda error:", e.message);
    return null;
  }
}

// ─── BOOKING.COM ──────────────────────────────────────────────────────────────
// booking-com15.p.rapidapi.com — real prices via RapidAPI
async function fetchBooking(params, rapidApiKey) {
  const { hotelName, lat, lng, checkIn, checkOut, adults, currency, nights } = params;
  if (!rapidApiKey) return null;

  try {
    const HOST = "booking-com15.p.rapidapi.com";

    // Step 1: Search destination to get dest_id
    const destRes = await fetch(
      `https://${HOST}/api/v1/hotels/searchDestination?query=${encodeURIComponent(hotelName)}`,
      {
        headers: {
          "X-RapidAPI-Key": rapidApiKey,
          "X-RapidAPI-Host": HOST
        }
      }
    );

    if (!destRes.ok) {
      console.log(`Booking dest search ${destRes.status}`);
      return null;
    }

    const destData = await destRes.json();
    const destinations = destData.data || [];

    // Find a hotel-type destination
    const hotelDest = destinations.find(d => d.dest_type === "hotel") || destinations[0];
    if (!hotelDest) return null;

    const destId = hotelDest.dest_id;
    const destType = hotelDest.dest_type || "city";

    // Step 2: Search hotel availability
    const searchQs = new URLSearchParams({
      dest_id: destId,
      search_type: destType,
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
      {
        headers: {
          "X-RapidAPI-Key": rapidApiKey,
          "X-RapidAPI-Host": HOST
        }
      }
    );

    if (!hotelsRes.ok) {
      console.log(`Booking search ${hotelsRes.status}`);
      return null;
    }

    const hotelsData = await hotelsRes.json();
    const hotels = hotelsData.data?.hotels || [];
    if (!hotels.length) return null;

    // Find best match
    let best = hotels[0];
    let bestScore = 0;
    for (const h of hotels) {
      const score = fuzzyMatch(h.property?.name || "", hotelName);
      if (score > bestScore) { bestScore = score; best = h; }
    }

    const totalPrice = best.property?.priceBreakdown?.grossPrice?.value;
    if (!totalPrice) return null;

    const bookingUrl = `https://www.booking.com/hotel/${best.property?.countryCode?.toLowerCase() || ""}/${best.property?.id}.html?checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=1&currency=${currency}`;

    return {
      ota: "booking",
      name: "Booking.com",
      pricePerNight: Math.round(totalPrice / nights),
      totalPrice: Math.round(totalPrice),
      currency,
      bookingUrl,
      hotelName: best.property?.name
    };
  } catch (e) {
    console.log("Booking error:", e.message);
    return null;
  }
}

// ─── EXPEDIA ──────────────────────────────────────────────────────────────────
// Expedia Rapid API v3 — direct, real prices, CID 506148 for affiliate tracking
async function fetchExpedia(params, apiKey, apiSecret, cid) {
  const { hotelName, lat, lng, checkIn, checkOut, adults, currency, nights } = params;
  if (!apiKey || !apiSecret) return null;

  try {
    const ts = Math.floor(Date.now() / 1000);
    const msgBuf = new TextEncoder().encode(`${apiKey}${apiSecret}${ts}`);
    const hashBuf = await crypto.subtle.digest("SHA-512", msgBuf);
    const sig = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
    const authHeader = `EAN apikey=${apiKey},signature=${sig},timestamp=${ts}`;

    // Search properties by geo
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
      console.log(`Expedia ${res.status}: ${await res.text().then(t => t.slice(0, 100))}`);
      return null;
    }

    const properties = await res.json();
    if (!Array.isArray(properties) || !properties.length) return null;

    let best = properties[0];
    let bestScore = 0;
    for (const p of properties) {
      const score = fuzzyMatch(p.property?.name || "", hotelName);
      if (score > bestScore) { bestScore = score; best = p; }
    }

    const room = best.rooms?.[0];
    const rate = room?.rates?.[0];
    const pricing = rate?.occupancy_pricing?.[`${adults}`];
    const totalPrice = pricing?.totals?.inclusive?.billable_currency?.value
      || pricing?.totals?.gross?.value;

    if (!totalPrice) return null;

    const propId = best.property?.id;
    const affiliateCid = cid || "506148";
    const bookingUrl = `https://www.expedia.com/h${propId}.Hotel-Information?chkin=${checkIn}&chkout=${checkOut}&rm1=a${adults}&mcicid=${affiliateCid}`;

    return {
      ota: "expedia",
      name: "Expedia",
      pricePerNight: Math.round(parseFloat(totalPrice) / nights),
      totalPrice: Math.round(parseFloat(totalPrice)),
      currency,
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
  const lat = parseFloat(p.get("lat") || "0");
  const lng = parseFloat(p.get("lng") || "0");

  if (!checkIn || !checkOut) {
    return jsonResponse({ error: "checkIn and checkOut are required" }, 400, origin, env);
  }
  if (!lat || !lng) {
    return jsonResponse({ error: "lat and lng are required for price lookup" }, 400, origin, env);
  }

  const nights = getNights(checkIn, checkOut);
  const params = { hotelName, hotelCode, lat, lng, checkIn, checkOut, adults, currency, nights };

  // Fire all OTA calls in parallel — gracefully skip if credentials missing
  const [agodaResult, bookingResult, expediaResult] = await Promise.allSettled([
    fetchAgoda(params, env.AGODA_API_KEY),
    fetchBooking(params, env.RAPIDAPI_KEY),
    fetchExpedia(params, env.EXPEDIA_API_KEY, env.EXPEDIA_API_SECRET, env.EXPEDIA_CID)
  ]);

  const rates = [
    agodaResult.status === "fulfilled" ? agodaResult.value : null,
    bookingResult.status === "fulfilled" ? bookingResult.value : null,
    expediaResult.status === "fulfilled" ? expediaResult.value : null
  ].filter(Boolean);

  const cheapestOta = rates.length ? Math.min(...rates.map(r => r.totalPrice)) : null;
  const savings = travlrPrice && cheapestOta && cheapestOta > travlrPrice
    ? Math.round(cheapestOta - travlrPrice) : 0;

  return jsonResponse({
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
      activeOtas: rates.map(r => r.ota)
    }
  }, 200, origin, env);
}

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
      case "/health":
        return jsonResponse({
          status: "ok",
          version: WORKER_VERSION,
          dataSource: "Agoda Affiliate Lite API + Booking.com RapidAPI + Expedia Rapid API",
          pricing: "All prices are total stay (not per-night). Apples to apples.",
          timestamp: new Date().toISOString()
        }, 200, origin, env);
      default:
        return jsonResponse({ error: "Not found", endpoints: ["/rates", "/health"] }, 404, origin, env);
    }
  }
};