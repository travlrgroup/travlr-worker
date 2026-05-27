/**
 * TRAVLR Price Confidence Widget — Embed Script
 * Version: 1.4.0
 *
 * Drop this single script tag onto any hotel detail page:
 *
 *   <script
 *     src="https://static.trvcdn.net/price-confidence-widget/prd/v1.2.0/embed.js"
 *     data-hotel-id="3173879"
 *     data-check-in="2026-09-24"
 *     data-check-out="2026-09-29"
 *     data-adults="2"
 *     data-currency="AUD"
 *     data-travlr-price="541"
 *     data-api-url="https://travlr-widget-api-production.travlr-widget-api.workers.dev"
 *     data-exit-intent="true"
 *     data-partner-id="mastercard"
 *   ></script>
 *
 * All data-* attributes are optional except data-hotel-id.
 * The widget auto-hides if no rates are returned from the API.
 *
 * Changes in v1.4.0:
 *   - Hide widget entirely if no rates returned OR TRAVLR price >= cheapest OTA price
 *   - Widget is invisible to users when it can't show a genuine saving
 *
 * Changes in v1.3.0:
 *   - Auto-reads CheckIn/CheckOut/CurrencyCode/Adults/HotelCode from page URL query params
 *     as fallbacks when data-* attributes are not set (fixes NaN on PlayTravel)
 *   - Changed "Book direct" to "Save with us" throughout
 *   - Updated footer: "Prices shown are for 1 room, indicative only..."
 *
 * Changes in v1.2.0:
 *   - Trip.com affiliate deep link row (isAffiliateLinkOnly: true from worker v4.5.0)
 *   - Trip.com row shows "View price →" CTA instead of a price
 *   - Savings headline is now bold and prominent: "Save up to $X here!"
 *   - Savings badge on every OTA row is now red (#dc2626) for urgency
 *   - OTA rows are now fully clickable (entire row links to bookingUrl)
 *   - Default API URL updated to production endpoint
 */
(function () {
  'use strict';

  // ─── Read config from script tag ──────────────────────────────────────────
  var scripts = document.querySelectorAll('script[data-hotel-id]');
  var scriptEl = scripts[scripts.length - 1];

  if (!scriptEl) {
    console.warn('[TRAVLR Widget] No script tag with data-hotel-id found.');
    return;
  }

  // Auto-extract hotel slug from page URL path (e.g. /accommodation/detail/{slug}?HotelCode=...)
  function extractSlugFromUrl() {
    var match = window.location.pathname.match(/\/accommodation\/detail\/([^/?#]+)/);
    return match ? match[1] : '';
  }

  // Auto-read URL query params as fallbacks (e.g. PlayTravel passes ?CheckIn=...&CheckOut=...)
  var _urlParams = new URLSearchParams(window.location.search);
  function _urlParam(key) {
    // Support both exact case and common variants (CheckIn / checkIn / check_in)
    return _urlParams.get(key) || _urlParams.get(key.toLowerCase()) || _urlParams.get(key.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')) || '';
  }

  var config = {
    hotelId:      scriptEl.getAttribute('data-hotel-id') || _urlParam('HotelCode') || '',
    hotelSlug:    scriptEl.getAttribute('data-hotel-slug') || extractSlugFromUrl(),
    checkIn:      scriptEl.getAttribute('data-check-in') || _urlParam('CheckIn') || '',
    checkOut:     scriptEl.getAttribute('data-check-out') || _urlParam('CheckOut') || '',
    adults:       parseInt(scriptEl.getAttribute('data-adults') || _urlParam('Adults') || '2', 10),
    currency:     scriptEl.getAttribute('data-currency') || _urlParam('CurrencyCode') || 'AUD',
    travlrPrice:  parseFloat(scriptEl.getAttribute('data-travlr-price') || '0') || null,
    apiUrl:       (scriptEl.getAttribute('data-api-url') || 'https://travlr-widget-api-production.travlr-widget-api.workers.dev').replace(/\/$/, ''),
    exitIntent:   scriptEl.getAttribute('data-exit-intent') === 'true',
    partnerId:    scriptEl.getAttribute('data-partner-id') || '',
    containerId:  scriptEl.getAttribute('data-container-id') || 'travlr-price-widget',
  };

  if (!config.hotelId) {
    console.warn('[TRAVLR Widget] data-hotel-id is required.');
    return;
  }

  // ─── Styles ───────────────────────────────────────────────────────────────
  var css = `
    #travlr-price-widget,
    #travlr-exit-intent-overlay {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      box-sizing: border-box;
    }
    #travlr-price-widget * { box-sizing: border-box; }
    #travlr-exit-intent-overlay * { box-sizing: border-box; }

    /* ── Inline widget ── */
    #travlr-price-widget {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 20px 24px;
      max-width: 480px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    .tw-header { margin-bottom: 16px; }
    .tw-title {
      font-size: 16px;
      font-weight: 700;
      color: #111827;
      margin: 0 0 4px;
    }
    .tw-subtitle {
      font-size: 13px;
      color: #6b7280;
      margin: 0;
    }

    /* Savings headline — prominent red banner above TRAVLR row */
    .tw-savings-headline {
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      color: #fff;
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 15px;
      font-weight: 800;
      text-align: center;
      letter-spacing: -0.2px;
    }
    .tw-savings-headline-sub {
      font-size: 12px;
      font-weight: 500;
      color: rgba(255,255,255,0.85);
      margin-top: 2px;
    }

    /* TRAVLR hero row */
    .tw-travlr-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(135deg, #00BFD9 0%, #0099b0 100%);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 12px;
    }
    .tw-travlr-label {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .tw-travlr-logo {
      width: 32px;
      height: 32px;
      background: rgba(255,255,255,0.2);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 800;
      color: #fff;
      letter-spacing: -0.5px;
    }
    .tw-travlr-name {
      font-size: 14px;
      font-weight: 700;
      color: #fff;
    }
    .tw-travlr-tag {
      font-size: 11px;
      color: rgba(255,255,255,0.85);
      margin-top: 1px;
    }
    .tw-travlr-price { text-align: right; }
    .tw-travlr-amount {
      font-size: 20px;
      font-weight: 800;
      color: #fff;
    }
    .tw-travlr-per-night {
      font-size: 11px;
      color: rgba(255,255,255,0.8);
    }
    .tw-book-btn {
      display: block;
      width: 100%;
      background: #fff;
      color: #00BFD9;
      border: none;
      border-radius: 6px;
      padding: 9px 16px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 10px;
      transition: background 0.15s;
      text-align: center;
      text-decoration: none;
    }
    .tw-book-btn:hover { background: #f0fdff; }

    /* OTA comparison rows */
    .tw-compare-label {
      font-size: 12px;
      font-weight: 600;
      color: #9ca3af;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    .tw-ota-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 6px;
      border-bottom: 1px solid #f3f4f6;
      text-decoration: none;
      color: inherit;
      border-radius: 6px;
      transition: background 0.1s;
    }
    .tw-ota-row:last-child { border-bottom: none; }
    .tw-ota-row:hover { background: #f9fafb; }
    .tw-ota-info {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .tw-ota-icon {
      width: 28px;
      height: 28px;
      border-radius: 5px;
      object-fit: cover;
      flex-shrink: 0;
    }
    .tw-ota-name {
      font-size: 14px;
      color: #374151;
      font-weight: 500;
    }
    .tw-ota-price-col { text-align: right; }
    .tw-ota-price {
      font-size: 15px;
      font-weight: 700;
      color: #374151;
    }
    .tw-ota-per-night {
      font-size: 11px;
      color: #9ca3af;
    }

    /* Savings badge — red for urgency */
    .tw-savings-badge {
      display: inline-block;
      background: #fee2e2;
      color: #dc2626;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 20px;
      margin-left: 6px;
    }

    /* Trip.com "View price" CTA */
    .tw-view-price-cta {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 13px;
      font-weight: 600;
      color: #00BFD9;
      text-decoration: none;
      white-space: nowrap;
    }
    .tw-view-price-cta:hover { color: #0099b0; text-decoration: underline; }

    .tw-footer {
      margin-top: 12px;
      font-size: 11px;
      color: #9ca3af;
      line-height: 1.5;
    }
    .tw-loading {
      text-align: center;
      padding: 24px;
      color: #9ca3af;
      font-size: 14px;
    }
    .tw-spinner {
      display: inline-block;
      width: 20px;
      height: 20px;
      border: 2px solid #e5e7eb;
      border-top-color: #00BFD9;
      border-radius: 50%;
      animation: tw-spin 0.7s linear infinite;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes tw-spin { to { transform: rotate(360deg); } }

    /* ── Exit intent overlay ── */
    #travlr-exit-intent-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.55);
      z-index: 99999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      animation: tw-fade-in 0.2s ease;
    }
    @keyframes tw-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .tw-exit-card {
      background: #fff;
      border-radius: 16px;
      padding: 28px 32px;
      max-width: 440px;
      width: 100%;
      position: relative;
      box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      animation: tw-slide-up 0.25s ease;
    }
    @keyframes tw-slide-up {
      from { transform: translateY(20px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }
    .tw-exit-close {
      position: absolute;
      top: 14px;
      right: 16px;
      background: none;
      border: none;
      font-size: 20px;
      color: #9ca3af;
      cursor: pointer;
      line-height: 1;
    }
    .tw-exit-close:hover { color: #374151; }
    .tw-exit-savings-banner {
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      color: #fff;
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 18px;
      font-weight: 800;
      text-align: center;
    }
    .tw-exit-headline {
      font-size: 20px;
      font-weight: 800;
      color: #111827;
      margin: 0 0 6px;
    }
    .tw-exit-sub {
      font-size: 14px;
      color: #6b7280;
      margin: 0 0 20px;
    }
    .tw-exit-stay-btn {
      display: block;
      width: 100%;
      background: #00BFD9;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px 20px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 16px;
      transition: background 0.15s;
    }
    .tw-exit-stay-btn:hover { background: #0099b0; }
    .tw-exit-leave-btn {
      display: block;
      width: 100%;
      background: none;
      color: #9ca3af;
      border: none;
      padding: 10px;
      font-size: 13px;
      cursor: pointer;
      margin-top: 6px;
    }
    .tw-exit-leave-btn:hover { color: #374151; }
  `;

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function formatPrice(amount, currency) {
    try {
      return new Intl.NumberFormat('en-AU', { style: 'currency', currency: currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
    } catch (e) {
      return currency + ' ' + Math.round(amount);
    }
  }

  function nights() {
    if (!config.checkIn || !config.checkOut) return 1;
    var d = (new Date(config.checkOut) - new Date(config.checkIn)) / 86400000;
    return d > 0 ? d : 1;
  }

  // ─── Fetch rates from worker ───────────────────────────────────────────────
  function fetchRates(callback) {
    var params = new URLSearchParams({
      hotelId:   config.hotelId,
      hotelSlug: config.hotelSlug,
      checkIn:   config.checkIn,
      checkOut:  config.checkOut,
      adults:    config.adults,
      currency:  config.currency,
    });
    var url = config.apiUrl + '/rates?' + params.toString();

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) { callback(null, data); })
      .catch(function (err) { callback(err, null); });
  }

  // ─── Build a single OTA row HTML ──────────────────────────────────────────
  // isAffiliateLinkOnly rows (e.g. Trip.com) show "View price →" instead of a price.
  // Live-priced rows show the price + savings badge and are wrapped in an <a> tag.
  function buildOtaRow(r, savings, n, showSavingsBadge) {
    var isAffiliate = r.isAffiliateLinkOnly === true;
    var savingsBadge = (!isAffiliate && showSavingsBadge && savings && savings > 0)
      ? '<span class="tw-savings-badge">Save ' + formatPrice(savings * n, config.currency) + '</span>'
      : '';

    var nameHtml =
      '<div class="tw-ota-info">' +
        (r.iconUrl ? '<img class="tw-ota-icon" src="' + r.iconUrl + '" alt="' + r.name + '">' : '') +
        '<span class="tw-ota-name">' + r.name + '</span>' +
        savingsBadge +
      '</div>';

    var priceHtml;
    if (isAffiliate) {
      priceHtml =
        '<div class="tw-ota-price-col">' +
          '<a class="tw-view-price-cta" href="' + (r.bookingUrl || '#') + '" target="_blank" rel="noopener">View price &#8594;</a>' +
        '</div>';
      // Affiliate rows: div wrapper (the CTA inside is already a link)
      return '<div class="tw-ota-row">' + nameHtml + priceHtml + '</div>';
    } else {
      priceHtml =
        '<div class="tw-ota-price-col">' +
          '<div class="tw-ota-price">' + formatPrice(r.totalPrice, config.currency) + '</div>' +
          '<div class="tw-ota-per-night">' + formatPrice(r.pricePerNight, config.currency) + '/night</div>' +
        '</div>';
      // Live-priced rows: entire row is a clickable link
      if (r.bookingUrl) {
        return '<a class="tw-ota-row" href="' + r.bookingUrl + '" target="_blank" rel="noopener">' + nameHtml + priceHtml + '</a>';
      }
      return '<div class="tw-ota-row">' + nameHtml + priceHtml + '</div>';
    }
  }

  // ─── Render inline widget ─────────────────────────────────────────────────
  function renderWidget(container, rates) {
    var n = nights();
    var travlrTotal = config.travlrPrice || null;
    var travlrPerNight = travlrTotal ? travlrTotal / n : null;

    // Only live-priced OTAs count toward savings calculation
    var livePrices = rates
      .filter(function (r) { return !r.isAffiliateLinkOnly && r.totalPrice; })
      .map(function (r) { return r.totalPrice; });
    var cheapestOta = livePrices.length ? Math.min.apply(null, livePrices) : null;
    var savings = (travlrTotal && cheapestOta && cheapestOta > travlrTotal)
      ? cheapestOta - travlrTotal : null;

    // Hide widget if TRAVLR price is not cheaper than the cheapest OTA, or no live prices
    if (!travlrTotal || !cheapestOta || travlrTotal >= cheapestOta) {
      container.style.display = 'none';
      return;
    }

    // Prominent savings headline
    var savingsHeadlineHtml = '';
    if (savings && savings > 0) {
      savingsHeadlineHtml =
        '<div class="tw-savings-headline">' +
          'Save up to ' + formatPrice(savings, config.currency) + ' here!' +
          '<div class="tw-savings-headline-sub">Save with us \u2014 don\'t pay more on other sites</div>' +
        '</div>';
    }

    var otaRows = rates.map(function (r) {
      return buildOtaRow(r, savings, n, true);
    }).join('');

    var travlrBlock = '';
    if (travlrPerNight) {
      travlrBlock =
        '<div class="tw-travlr-row">' +
          '<div class="tw-travlr-label">' +
            '<div class="tw-travlr-logo">T</div>' +
            '<div><div class="tw-travlr-name">Save with us</div></div>' +
          '</div>' +
          '<div class="tw-travlr-price">' +
            '<div class="tw-travlr-amount">' + formatPrice(travlrTotal, config.currency) + '</div>' +
            '<div class="tw-travlr-per-night">' + formatPrice(travlrPerNight, config.currency) + '/night</div>' +
          '</div>' +
        '</div>' +
        '<button class="tw-book-btn" onclick="window.travlrWidgetBookNow && window.travlrWidgetBookNow()">Book now</button>';
    }

    container.innerHTML =
      '<div class="tw-header">' +
        '<p class="tw-title">See how we compare</p>' +
        '<p class="tw-subtitle">Live prices from top booking sites.</p>' +
      '</div>' +
      savingsHeadlineHtml +
      travlrBlock +
      (rates.length ? '<div class="tw-compare-label">Others charge</div>' + otaRows : '') +
      '<p class="tw-footer">Prices shown are for 1 room, indicative only and are sourced from third-party sites.</p>';
  }

  // ─── Exit intent popup ────────────────────────────────────────────────────
  function setupExitIntent(rates) {
    if (!config.exitIntent) return;

    var sessionKey = 'tw_exit_shown_' + config.hotelId;
    if (sessionStorage.getItem(sessionKey)) return;

    var triggered = false;

    function showPopup() {
      if (triggered) return;
      triggered = true;
      sessionStorage.setItem(sessionKey, '1');

      var n = nights();
      var travlrTotal = config.travlrPrice || null;
      var livePrices = rates
        .filter(function (r) { return !r.isAffiliateLinkOnly && r.totalPrice; })
        .map(function (r) { return r.totalPrice; });
      var cheapestOta = livePrices.length ? Math.min.apply(null, livePrices) : null;
      var savings = (travlrTotal && cheapestOta && cheapestOta > travlrTotal)
        ? cheapestOta - travlrTotal : null;

      var headline = savings && savings > 0
        ? 'Wait \u2014 you could save ' + formatPrice(savings, config.currency)
        : 'Wait \u2014 are you sure you want to leave?';
      var sub = savings && savings > 0
        ? 'You\'re about to miss a saving of ' + formatPrice(savings, config.currency) + ' vs other sites. Save with us and keep the difference.'
        : 'Save with us and keep the savings.';

      var overlay = document.createElement('div');
      overlay.id = 'travlr-exit-intent-overlay';

      var savingsBannerHtml = savings && savings > 0
        ? '<div class="tw-exit-savings-banner">Save up to ' + formatPrice(savings, config.currency) + ' here!</div>'
        : '';

      // Exit intent shows only live-priced rows (no affiliate rows)
      var otaRowsHtml = rates
        .filter(function (r) { return !r.isAffiliateLinkOnly; })
        .slice(0, 3)
        .map(function (r) { return buildOtaRow(r, savings, n, false); })
        .join('');

      var travlrBlock = travlrTotal
        ? '<div class="tw-travlr-row" style="margin-bottom:12px">' +
            '<div class="tw-travlr-label">' +
              '<div class="tw-travlr-logo">T</div>' +
              '<div><div class="tw-travlr-name">Save with us</div></div>' +
            '</div>' +
            '<div class="tw-travlr-price">' +
              '<div class="tw-travlr-amount">' + formatPrice(travlrTotal, config.currency) + '</div>' +
            '</div>' +
          '</div>'
        : '';

      var bookBtnLabel = savings && savings > 0
        ? 'Book now \u2014 save ' + formatPrice(savings, config.currency)
        : 'Book now';

      overlay.innerHTML =
        '<div class="tw-exit-card">' +
          '<button class="tw-exit-close" aria-label="Close">&times;</button>' +
          savingsBannerHtml +
          '<h2 class="tw-exit-headline">' + headline + '</h2>' +
          '<p class="tw-exit-sub">' + sub + '</p>' +
          travlrBlock +
          (otaRowsHtml ? '<div class="tw-compare-label">Others charge</div>' + otaRowsHtml : '') +
          '<button class="tw-exit-stay-btn">' + bookBtnLabel + '</button>' +
          '<button class="tw-exit-leave-btn">No thanks, I\'ll continue browsing</button>' +
        '</div>';

      document.body.appendChild(overlay);

      function close() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }

      overlay.querySelector('.tw-exit-close').addEventListener('click', close);
      overlay.querySelector('.tw-exit-leave-btn').addEventListener('click', close);
      overlay.querySelector('.tw-exit-stay-btn').addEventListener('click', function () {
        close();
        window.travlrWidgetBookNow && window.travlrWidgetBookNow();
      });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
      });
    }

    // Desktop: mouse leaves viewport top
    document.addEventListener('mouseleave', function (e) {
      if (e.clientY < 10) showPopup();
    });

    // Mobile fallback: 45s idle
    var idleTimer = setTimeout(showPopup, 45000);
    ['touchstart', 'scroll', 'keydown'].forEach(function (ev) {
      document.addEventListener(ev, function () {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(showPopup, 45000);
      }, { passive: true });
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    var container = document.getElementById(config.containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = config.containerId;
      scriptEl.parentNode.insertBefore(container, scriptEl.nextSibling);
    }

    container.innerHTML = '<div class="tw-loading"><span class="tw-spinner"></span>Checking prices\u2026</div>';

    fetchRates(function (err, data) {
      if (err || !data || !data.rates || data.rates.length === 0) {
        container.style.display = 'none';
        return;
      }
      renderWidget(container, data.rates);
      setupExitIntent(data.rates);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
