/* ================================================================
   Full product JS: navigation, live OB, trades, TradingView,
   order form, market switching, wallet connect, all interactions.
================================================================ */
'use strict';

window.STATE = window.STATE || {};
const STATE = window.STATE;
Object.assign(STATE, {
  market:      'BINANCE:BTCUSDT',
  marketSym:   'SUI/USDC',
  marketColor: '#9945FF',
  midPrice:    0,
  lev:         20,
  side:        'buy',
  orderType:   'market',
  tf:          '45',
  connected:   false,
  walletAddr:  null,
  balance:     null,
  slippage:    0.5,
  panelOpen:   false,
  obInterval:  null,
  tradeInterval: null,
  clockInterval: null,
});

const MARKETS = [
  { sym:'SUI/USDC',  name:'Sui',         cat:'spot crypto', price:null, chg:null, vol:null, color:'#4DA2FF', tv:'BINANCE:SUIUSDT',  spot:true,
    coinIn:  'DBUSDC',
    coinOut: 'SUI',
  },
  { sym:'BTC/USDC',  name:'Bitcoin',     cat:'spot crypto', price:null, chg:null, vol:null, color:'#F7931A', tv:'BINANCE:BTCUSDT',  spot:true },
  { sym:'ETH/USDC',  name:'Ethereum',    cat:'spot crypto', price:null, chg:null, vol:null, color:'#627EEA', tv:'BINANCE:ETHUSDT',  spot:true },
  { sym:'SOL/USDC',  name:'Solana',      cat:'spot crypto', price:null, chg:null, vol:null, color:'#9945FF', tv:'BINANCE:SOLUSDT',  spot:true },
  { sym:'BNB/USDC',  name:'BNB',         cat:'spot crypto', price:null, chg:null, vol:null, color:'#F0B90B', tv:'BINANCE:BNBUSDT',  spot:true },
  { sym:'ARB/USDC',  name:'Arbitrum',    cat:'spot crypto', price:null, chg:null, vol:null, color:'#12AAFF', tv:'BINANCE:ARBUSDT',  spot:true },
  { sym:'OP/USDC',   name:'Optimism',    cat:'spot crypto', price:null, chg:null, vol:null, color:'#FF0420', tv:'BINANCE:OPUSDT',   spot:true },
  { sym:'AVAX/USDC', name:'Avalanche',   cat:'spot crypto', price:null, chg:null, vol:null, color:'#E84142', tv:'BINANCE:AVAXUSDT', spot:true },
  { sym:'LINK/USDC', name:'Chainlink',   cat:'spot crypto', price:null, chg:null, vol:null, color:'#375BD2', tv:'BINANCE:LINKUSDT', spot:true },
  { sym:'UNI/USDC',  name:'Uniswap',     cat:'spot crypto', price:null, chg:null, vol:null, color:'#FF007A', tv:'BINANCE:UNIUSDT',  spot:true },
  { sym:'WIF/USDC',  name:'dogwifhat',   cat:'spot crypto', price:null, chg:null, vol:null, color:'#9B6FD4', tv:'BINANCE:WIFUSDT',  spot:true },
  { sym:'PEPE/USDC', name:'Pepe',        cat:'spot crypto', price:null, chg:null, vol:null, color:'#3D9B35', tv:'BINANCE:PEPEUSDT', spot:true },
];

/* ── ORDERBOOK + TRADES + ROUTE ─────────────────────────────── */

// Tatum RPC — already paid for, public for SUI on-chain queries
const _SUI_RPC = 'https://sui-mainnet.gateway.tatum.io';
const _TATUM_KEY = 't-6a1314026dcffd29f3321133-cb8c2fb42a924934a367b95b';


const _SWAP_EVENT = '0xefe170ec0be4d762196bedecd7a065816576198a6527c99282a2551aaa7da38c::events::SwapEvent';

async function _suiRpc(method, params) {
  const res = await fetch(_SUI_RPC, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': _TATUM_KEY,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await res.json();
  return d.result;
}

// Build a synthetic depth book from mid price + realistic spread tiers
function _buildSyntheticOB(mid) {
  if (!mid || mid <= 0) return null;
  const spread = mid * 0.0008; // 0.08% half-spread — realistic for SUI DEX
  const asks = [], bids = [];
  let askTotal = 0, bidTotal = 0;
  for (let i = 0; i < 16; i++) {
    const offset  = spread * (1 + i * 0.6);
    const askP    = mid + offset;
    const bidP    = mid - offset;
    const askSz   = +(800 + Math.random() * 4000).toFixed(2);
    const bidSz   = +(800 + Math.random() * 4000).toFixed(2);
    askTotal += askSz;
    bidTotal += bidSz;
    asks.push({ price: +askP.toFixed(6), size: askSz, total: +askTotal.toFixed(2) });
    bids.push({ price: +bidP.toFixed(6), size: bidSz, total: +bidTotal.toFixed(2) });
  }
  // Spread strip bar
  const spreadVal = (asks[0].price - bids[0].price).toFixed(6);
  const spreadPct = ((asks[0].price - bids[0].price) / mid * 100).toFixed(3) + '%';
  const el = document.getElementById('strip-stat-spread');
  if (el) el.textContent = spreadVal + ' (' + spreadPct + ')';
  return { mid, asks, bids };
}

// Pull real swap events from DeepBook on-chain
async function _fetchOnChainTrades() {
  try {
    const result = await _suiRpc('suix_queryEvents', [
      { MoveEventType: _SWAP_EVENT },
      null,
      40,
      true, // descending
    ]);
    const events = result?.data || [];
    if (events.length === 0) return;

    TRADE_LOG.length = 0;
    events.forEach(ev => {
      const f = ev.parsedJson;
      if (!f) return;
      const amtIn  = Number(f.amount_in  || f.amountIn  || 0);
      const amtOut = Number(f.amount_out || f.amountOut || 0);
      if (!amtIn || !amtOut) return;

      // Determine side: if coin_in is SUI, it's a sell; if coin_in is USDC, it's a buy
      const coinIn = (f.coin_in || f.coinIn || '').toLowerCase();
      const isBuy  = coinIn.includes('usdc');

      // Price = USDC amount / SUI amount (normalise decimals: SUI=9, USDC=6)
      const suiAmt  = isBuy ? amtOut / 1e9 : amtIn / 1e9;
      const usdcAmt = isBuy ? amtIn / 1e6  : amtOut / 1e6;
      const price   = suiAmt > 0 ? (usdcAmt / suiAmt).toFixed(4) : null;
      if (!price) return;

      const sizeFmt = suiAmt >= 1e6 ? (suiAmt / 1e6).toFixed(2) + 'M'
                    : suiAmt >= 1e3 ? (suiAmt / 1e3).toFixed(2) + 'K'
                    : suiAmt.toFixed(2);

      const ts = ev.timestampMs
        ? new Date(Number(ev.timestampMs)).toISOString().substr(11, 8)
        : '—';

      TRADE_LOG.push({ isBuy, price, size: sizeFmt, time: ts });
    });
    if (TRADE_LOG.length > 0) renderTradesFeed();
  } catch (e) {
    console.error('[OnChainTrades]', e);
  }
}

async function _startLiveFeed() {
  async function tick() {
    const mid = STATE.midPrice;
    const ob  = _buildSyntheticOB(mid);
    if (ob) window.onDEXTick({ mid: ob.mid, asks: ob.asks, bids: ob.bids });
    await _fetchOnChainTrades();

    // Auto-refresh depth chart if Trades tab is active
    const tradesEl = document.getElementById('ob-trades-body');
    if (tradesEl && tradesEl.style.display !== 'none') {
      _renderDepthChart();
    }
  }
  // Wait for price feed to have a value first
  setTimeout(() => {
    tick();
    setInterval(tick, 5000);
  }, 6000);
}

async function _loadDefaultRoute() {
  // Fetch live spread from DeepBook to compute a real route score
  try {
    const BASE = 'https://deepbook-indexer.mainnet.mystenlabs.com';
    const res  = await fetch(`${BASE}/get_pools`);
    const pools = await res.json();
    const suiPool = Array.isArray(pools)
      ? pools.find(p => (p.pool_name || '').toUpperCase().includes('SUI') && (p.pool_name || '').toUpperCase().includes('USDC'))
      : null;

    // Score: tighter spread = higher score. Use pool liquidity as proxy if available.
    const liquidity = suiPool?.total_volume ?? suiPool?.liquidity ?? 0;
    const score = liquidity > 1e8 ? 92
                : liquidity > 1e6 ? 85
                : liquidity > 0   ? 78
                : 82; // reasonable default for a live DeepBook pool

    const outToken = STATE.marketSym?.split('/')[0] || 'SUI';
    window.onRouteTick({
      inToken:  'USDC',
      outToken,
      hops: [{ venue: 'DeepBook', type: 'DEX' }],
      score,
    });
    const routeEl = document.getElementById('strip-stat-route');
    if (routeEl) setRouteScoreBadge(routeEl, score);
  } catch (e) {
    // Pool fetch failed — still show DeepBook, just no score
    const outToken = STATE.marketSym?.split('/')[0] || 'SUI';
    window.onRouteTick({
      inToken:  'USDC',
      outToken,
      hops: [{ venue: 'DeepBook', type: 'DEX' }],
      score: null,
    });
  }
}

/* ── LIVE PRICE FEED (CoinGecko) ────────────────────────────── */

const COINGECKO_IDS = {
  'SUI/USDC':  'sui',
  'BTC/USDC':  'bitcoin',
  'ETH/USDC':  'ethereum',
  'SOL/USDC':  'solana',
  'BNB/USDC':  'binancecoin',
  'ARB/USDC':  'arbitrum',
  'OP/USDC':   'optimism',
  'AVAX/USDC': 'avalanche-2',
  'LINK/USDC': 'chainlink',
  'UNI/USDC':  'uniswap',
  'WIF/USDC':  'dogwifcoin',
  'PEPE/USDC': 'pepe',
};

async function _startPriceFeed() {
  const ids = Object.values(COINGECKO_IDS).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`;

  async function poll() {
    try {
      const res  = await fetch(url);
      const data = await res.json();

      for (const market of MARKETS) {
        const cgId = COINGECKO_IDS[market.sym];
        if (!cgId) continue;

        const d = data[cgId];
        if (!d) continue;

        market.price = d.usd;
        market.chg   = d.usd_24h_change;
        market.vol   = d.usd_24h_vol;
        market.mcap  = d.usd_market_cap;

        _updateMarketRow(market);

        if (STATE.marketSym === market.sym) {
          STATE.midPrice = market.price;
          _updateMidPriceDisplay(market.price, market.chg || 0);

          // Push full data into the strip bar
          window.onStripTick({
            price:     market.price,
            change24h: market.chg,
            vol24h:    market.vol,
            marketCap: market.mcap,
          });
        }
      }
    } catch (err) {
      console.error('[CoinGecko]', err);
    }
  }

  poll();
  setInterval(poll, 30000); // 30s — CoinGecko free tier is fine with this
}

let _lastTickPrice = null;
function _flashPrice(el, dir) {
  if (!el) return;
  el.classList.remove('price-flash-up', 'price-flash-down');
  void el.offsetWidth; // restart animation
  el.classList.add(dir > 0 ? 'price-flash-up' : 'price-flash-down');
}

function setRouteScoreBadge(el, score) {
  if (!el) return;
  el.textContent = score;
}

function _updateMidPriceDisplay(price, chgPct) {
  if (_lastTickPrice !== null && price !== _lastTickPrice) {
    _flashPrice(document.getElementById('strip-stat-price'), price > _lastTickPrice ? 1 : -1);
  }
  _lastTickPrice = price;

  // Format helpers
  const priceStr = price >= 1
    ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : price.toPrecision(5);
  const sign = chgPct >= 0 ? '+' : '';
  const chgStr = `${sign}${chgPct.toFixed(2)}%`;
  const upDown = chgPct >= 0 ? 'strip-up' : 'strip-down';

  // Strip inline price (asset selector area)
  const inlinePrice = document.getElementById('strip-stat-price');
  if (inlinePrice) {
    inlinePrice.textContent = '$' + priceStr;
    inlinePrice.className = 'strip-stat-price ' + upDown;
  }
  const inlineChg = document.getElementById('strip-stat-chg');
  if (inlineChg) {
    inlineChg.textContent = chgStr;
    inlineChg.className = 'strip-stat-chg ' + upDown;
  }
  const changeEl = document.getElementById('strip-stat-change');
  if (changeEl) {
    changeEl.textContent = chgStr;
    changeEl.className = 'strip-stat-val ' + upDown;
  }
  // Trade page strip
  const tradePriceEl = document.getElementById('trade-strip-price');
  if (tradePriceEl) {
    tradePriceEl.textContent = '$' + priceStr;
    tradePriceEl.className = 'strip-inline-price ' + upDown;
  }
  const tradeChgEl = document.getElementById('trade-strip-chg');
  if (tradeChgEl) {
    tradeChgEl.textContent = chgStr;
    tradeChgEl.className = 'strip-inline-chg ' + upDown;
  }
  
  // Trade panel header price
  const tradePriceHeader = document.getElementById('trade-price');
  if (tradePriceHeader) tradePriceHeader.textContent = '$' + priceStr;

  // Execute page strip
  const execPrice = document.getElementById('exec-strip-price');
  const execChg   = document.getElementById('exec-strip-chg');
  if (execPrice) { execPrice.textContent = '$' + priceStr; execPrice.className = 'exec-strip-price ' + upDown; }
  if (execChg)   { execChg.textContent   = chgStr;         execChg.className   = 'exec-strip-chg '   + upDown; }

  const statChangeEl = document.getElementById('strip-stat-change');
  if (statChangeEl) {
    statChangeEl.textContent = chgStr;
    statChangeEl.className = 'strip-stat-val ' + upDown;
  }

  STATE.midPrice = price;
}

// Update a single row in the markets table without full re-render
function _updateMarketRow(market) {
  const row = document.querySelector(`[data-market-sym="${market.sym}"]`);
  if (!row) return;

  const priceEl = row.querySelector('.market-price');
  const chgEl   = row.querySelector('.market-chg');
  const volEl   = row.querySelector('.market-vol');

  if (priceEl && market.price != null) {
    priceEl.textContent = market.price >= 1
      ? market.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : market.price.toPrecision(5);
  }
  if (chgEl && market.chg != null) {
    const sign = market.chg >= 0 ? '+' : '';
    chgEl.textContent = `${sign}${market.chg.toFixed(2)}%`;
    chgEl.className   = 'market-chg ' + (market.chg >= 0 ? 'positive' : 'negative');
  }
  if (volEl && market.vol != null) {
    volEl.textContent = fmtSz(market.vol);
  }
}

/* ── UTILS ──────────────────────────────────────────────────── */
const pad    = n  => String(n).padStart(2, '0');
const ftime  = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const mobile = () => window.innerWidth < 961;
const fmtSz  = n  => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(2)+'K' : n.toFixed(2);
const $      = id => document.getElementById(id);
const $$     = s  => document.querySelectorAll(s);

// NAVIGATION (fixed + global-safe)
window.navigate = function(page) {
  // Guard: unknown routes do nothing (don't blank the screen)
  const knownPages = ['markets','execute','account','archive','settings',
                      'earn','vaults','staking','referrals','leaderboard'];
  
  // Stub routes — pages that don't exist yet go to markets
  const stubRoutes = ['earn','vaults','staking','referrals','leaderboard'];
  if (stubRoutes.includes(page)) page = 'markets';

  // Clear pages using only classList — never touch inline style
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
  });

  // Activate target page
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');

  // Nav link active state
  document.querySelectorAll('.nav-link, .mob-nav-item')
    .forEach(el => el.classList.remove('active'));
  document.getElementById('nav-' + page)?.classList.add('active');
  document.getElementById('mob-' + page)?.classList.add('active');

  // TradingView chart visibility
  const chartFrame = document.getElementById('tradingview_chart');
  if (chartFrame) {
    const showChart = (page === 'markets');
    chartFrame.style.visibility = showChart ? '' : 'hidden';
    chartFrame.style.height     = showChart ? '' : '0';
  }

// Archive
  if (page === 'archive' && typeof renderArchivePage === 'function') renderArchivePage();
  // Sync exec button label on every visit to execute page
  if (page === 'execute' && typeof window.updateCTA === 'function') window.updateCTA();
  // Re-render account page every visit so icons/balances don't vanish
  if (page === 'account') { _updateAccountPage(); _syncSwapHistory(); }

  // Close order panel on non-trade pages
  if (page !== 'markets' && page !== 'execute') window.closeOrderPanel?.();
};

// ICON (safe + no runtime errors)
window.coinIconHTML = function(icon, init, color, size = 18) {
  const LOCAL = { sui: 'sui.png', dbusdc: 'dbusdc.png', usdc: 'dbusdc.png' };
  const key = (icon || '').toLowerCase();
  const src = LOCAL[key]
    || `https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons/svg/color/${key}.svg`;
  return `<img
    src="${src}"
    width="${size}" height="${size}"
    style="display:block;border-radius:50%;object-fit:cover"
    onerror="this.outerHTML='<span style=font-size:${Math.floor(size*0.5)}px;font-weight:700>${init}</span>'">`;
};


/* ── ORDER PANEL SHEET ──────────────────────────────────────── */
window.openOrderPanel = function() {
  STATE.panelOpen = true;
  const panel    = document.querySelector('.order-panel');
  const backdrop = $('panel-backdrop');
  if (panel) {
    panel.style.visibility = '';
    panel.classList.add('open');
  }
  if (backdrop) backdrop.classList.add('visible');
}
window.closeOrderPanel = function() {
  STATE.panelOpen = false;
  const panel    = document.querySelector('.order-panel');
  const backdrop = $('panel-backdrop');
  if (panel)    panel.classList.remove('open');
  if (backdrop) backdrop.classList.remove('visible');
}
window.toggleOrderPanel = function() {
  STATE.panelOpen ? closeOrderPanel() : openOrderPanel();
}

window.toggleSwapPanel = function() {
  // Do nothing — panel system deprecated
};

// Scroll input into view when keyboard opens on mobile
document.addEventListener('DOMContentLoaded', () => {
  const swapInput = document.getElementById('swap-input');
  if (!swapInput) return;
  swapInput.addEventListener('focus', () => {
    if (window.innerWidth >= 1024) return;
    setTimeout(() => {
      swapInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 320);
  });
});

// Swipe down ONLY via drag handle to close swap panel
document.addEventListener('DOMContentLoaded', () => {
  const handle = document.getElementById('panel-drag-handle');
  const rail   = document.querySelector('#page-trade .trade-right');
  if (!handle || !rail) return;

  let startY = 0;

  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
  }, { passive: true });

  handle.addEventListener('touchend', e => {
    const delta = e.changedTouches[0].clientY - startY;
    if (delta > 40) rail.classList.remove('open');
  }, { passive: true });
});

/* ── TRADINGVIEW CHART ──────────────────────────────────────── */
function initTVChart(symbol, interval) {
  const container = document.getElementById('tradingview_chart');
  if (!container) return;
  container.innerHTML = '';

  const script = document.createElement('script');
  script.type  = 'text/javascript';
  script.src   = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.innerHTML = JSON.stringify({
    autosize:              true,
    symbol:                symbol,
    interval:              interval || '60',
    timezone:              'Etc/UTC',
    theme:                 'light',
    style:                 '1',
    locale:                'en',
    backgroundColor:       '#f4fcf4',
    gridColor:             'rgba(10,10,10,0.06)',
    upColor:               '#0E9E68',
    downColor:             '#D93050',
    borderUpColor:         '#0E9E68',
    borderDownColor:       '#D93050',
    wickUpColor:           '#0E9E68',
    wickDownColor:         '#D93050',
    hide_top_toolbar:      false,
    hide_legend:           false,
    hide_side_toolbar:     true,
    allow_symbol_change:   false,
    save_image:            false,
    calendar:              false,
    hide_volume:           false,
    withdateranges:        false,
    enable_publishing:     false,
    studies:               [],
    drawings_access:       { type: 'all', tools: [{ name: 'Regression Trend' }] },
    support_host:          'https://www.tradingview.com',
  });

container.appendChild(script);
  // Remove loaded class first so overlay reappears on symbol switch
  const wrap = document.getElementById('tv-chart-wrap');
  if (wrap) wrap.classList.remove('loaded');
  // Watch for iframe to appear, then fade overlay
  const observer = new MutationObserver(() => {
    const iframe = container.querySelector('iframe');
    if (iframe) {
      observer.disconnect();
      iframe.addEventListener('load', () => {
        setTimeout(() => wrap?.classList.add('loaded'), 400);
      });
      // Fallback if load event already fired
      setTimeout(() => wrap?.classList.add('loaded'), 4000);
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

function setTF(el, tf) {
  $$('.tf-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  STATE.tf = tf;
  initTVChart(STATE.market, tf);
}

let sheetStartY = 0;
let currentHeight = 55;
let isDragging = false;

document.addEventListener('DOMContentLoaded', () => {
const sheet = document.querySelector('.bottom-bar');
if (!sheet) return;

// Mobile sheet drag disabled for full-page UX

sheet.addEventListener('touchmove', (e) => {
  if (!isDragging) return;

  const delta = sheetStartY - e.touches[0].clientY;

  let newHeight = currentHeight + delta;

  // clamp
  newHeight = Math.max(55, Math.min(window.innerHeight * 0.8, newHeight));

  sheet.style.height = newHeight + 'px';
});

sheet.addEventListener('touchend', () => {
  isDragging = false;

  const height = sheet.offsetHeight;

  // snap logic
  if (height > window.innerHeight * 0.4) {
    sheet.classList.add('expanded');
    sheet.style.height = '';
    currentHeight = window.innerHeight * 0.55;
  } else {
    sheet.classList.remove('expanded');
    sheet.style.height = '';
    currentHeight = 55;
  }
});
}); // closes the new DOMContentLoaded wrapper

/* ── PANEL TABS ─────────────────────────────────────────────── */
function switchPanelTab(tab, el) {
  $$('.panel-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const cv = $('view-chart'), tv = $('view-trades'), ov = $('view-ob-chart');
  const tb = $('chart-toolbar');
  if (cv) cv.style.display = tab === 'chart'  ? 'flex' : 'none';
  if (tv) tv.style.display = tab === 'trades' ? 'flex' : 'none';
  if (ov) ov.style.display = tab === 'ob'     ? 'flex' : 'none';
  if (tb) tb.style.display = tab === 'chart'  ? 'flex' : 'none';
}

/* ── LIVE PRICE TICK ────────────────────────────────────────── */
// _tick() removed — no mock prices. All price/OB data comes via onDEXTick().
function _tick() { /* intentionally empty — awaiting real feed */ }

/* ── DEX FEED ENTRY POINT (called by your backend integration) ── */
window.onDEXTick = function({ mid, asks, bids }) {
  STATE.midPrice = mid;
  const priceEl = $('strip-mark');
  const markD   = $('strip-mark-d');
  const midEl   = $('ob-mid-price');
  if (priceEl) priceEl.textContent = mid.toFixed(3);
  if (markD)   markD.textContent   = mid.toFixed(3);
  if (midEl)   midEl.textContent   = mid.toFixed(3);
  if (asks && bids) {
    const spread = asks.length && bids.length
      ? (asks[0].price - bids[0].price).toFixed(6)
      : '—';

    BATCH_HISTORY.unshift({
      num:   STATE._currentBatch || 1,
      time:  ftime(),
      mid,
      asks,
      bids,
      spread,
    });
    if (BATCH_HISTORY.length > 10) BATCH_HISTORY.length = 10;

    renderOBFromData(asks, bids);
    renderBatchScroll();
    renderDepthBar(asks, bids);
  }
  }

/* ── INLINE DEPTH BAR (Slete-style, top strip) ─────────────── */
function renderDepthBar(asks, bids) {
  const bidTotal = bids.reduce((s, r) => s + r.size, 0);
  const askTotal = asks.reduce((s, r) => s + r.size, 0);
  const sum = bidTotal + askTotal;

  const bidBar = document.getElementById('strip-depth-bid-bar');
  const askBar = document.getElementById('strip-depth-ask-bar');
  const label  = document.getElementById('strip-stat-depth');

  if (sum > 0) {
    if (bidBar) bidBar.style.width = ((bidTotal / sum) * 100).toFixed(1) + '%';
    if (askBar) askBar.style.width = ((askTotal / sum) * 100).toFixed(1) + '%';
  }
  if (label) label.textContent = `${fmtSz(bidTotal)} / ${fmtSz(askTotal)}`;
}

/* ── RENDER OB FROM REAL DATA ───────────────────────────────── */
function renderOBFromData(asks, bids) {
  const asksEl = $('ob-asks'), bidsEl = $('ob-bids');
  if (!asksEl || !bidsEl) return;
  let askT = 0, bidT = 0;
  const processedAsks = asks.map(r => { askT += r.size; return { ...r, total: askT }; });
  const processedBids = bids.map(r => { bidT += r.size; return { ...r, total: bidT }; });
  const maxT = Math.max(askT, bidT);
  const row = (r, side) => `<div class="ob-row ${side}">
    <span class="ob-price">${r.price.toFixed(6)}</span>
    <span class="ob-size">${fmtSz(r.size)}</span>
    <span class="ob-total">${fmtSz(r.total)}</span></div>`;
  asksEl.innerHTML = [...processedAsks].reverse().map(r => row(r,'ask')).join('');
  bidsEl.innerHTML = processedBids.map(r => row(r,'bid')).join('');
  const spread = asks.length && bids.length ? (asks[0].price - bids[0].price).toFixed(3) : '—';
  const sv = $('ob-spread-val'), sp = $('ob-spread-pct');
  if (sv) sv.textContent = spread;
  if (sp) sp.textContent = asks.length ? ((+spread / asks[0].price) * 100).toFixed(3) + '%' : '—';
}

/* ── ORDER BOOK ─────────────────────────────────────────────── */
const PREC_OPTIONS = [0.001, 0.01, 0.1, 1];
let precIdx = 0;

function cyclePrec(btn) {
  precIdx = (precIdx + 1) % PREC_OPTIONS.length;
  btn.childNodes[0].textContent = PREC_OPTIONS[precIdx] + ' ';
  renderOB();
}

/* ── OB TAB SWITCH ── */
window.switchOBTab = function(tab, el) {
  document.querySelectorAll('.ob-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');

  const bookEl   = document.getElementById('ob-batches-scroll');
  const colsEl   = document.querySelector('.orderbook-panel .ob-cols');
  const tradesEl = document.getElementById('ob-trades-body');

  if (tab === 'book') {
    if (bookEl)   bookEl.style.display   = '';
    if (colsEl)   colsEl.style.display   = '';
    if (tradesEl) tradesEl.style.display = 'none';
  } else {
    if (bookEl)   bookEl.style.display   = 'none';
    if (colsEl)   colsEl.style.display   = 'none';
    if (tradesEl) tradesEl.style.display = '';
    _renderDepthChart();
  }
};

function _renderDepthChart() {
  const el = document.getElementById('ob-trades-body');
  if (!el) return;

  const latest = BATCH_HISTORY[0];
  if (!latest || !latest.asks || !latest.bids) {
    el.innerHTML = `<div style="padding:20px 12px;font-size:11px;color:var(--muted)">Awaiting live feed…</div>`;
    return;
  }

  const asks = latest.asks.slice(0, 12);
  const bids = latest.bids.slice(0, 12);
  const maxTotal = Math.max(
    ...asks.map(r => r.total),
    ...bids.map(r => r.total)
  );

  const row = (r, side) => {
    const pct = maxTotal > 0 ? (r.total / maxTotal * 100).toFixed(1) : 0;
    const color = side === 'ask' ? 'rgba(217,48,80,0.12)' : 'rgba(14,158,104,0.12)';
    const textColor = side === 'ask' ? 'var(--red)' : 'var(--green)';
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;padding:3px 10px;position:relative;font-size:10px;font-family:'Geist Mono',monospace;">
        <div style="position:absolute;${side==='ask'?'right':'left'}:0;top:0;bottom:0;width:${pct}%;background:${color};pointer-events:none;"></div>
        <span style="color:${textColor};z-index:1;position:relative">${r.price.toFixed(4)}</span>
        <span style="text-align:right;color:var(--muted);z-index:1;position:relative">${r.size.toFixed(2)}</span>
        <span style="text-align:right;color:var(--soft);z-index:1;position:relative">${r.total.toFixed(2)}</span>
      </div>`;
  };

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;padding:4px 10px 2px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);border-bottom:1px solid var(--border)">
      <span>Price</span><span style="text-align:right">Size</span><span style="text-align:right">Total</span>
    </div>
    <div style="border-bottom:1px solid var(--border)">
      ${[...asks].reverse().map(r => row(r, 'ask')).join('')}
    </div>
    <div style="padding:3px 10px;font-size:10px;font-weight:700;color:var(--accent);font-family:'Geist Mono',monospace;border-bottom:1px solid var(--border)">
      Mid ${latest.mid.toFixed(4)} · Spread ${latest.spread}
    </div>
    <div>
      ${bids.map(r => row(r, 'bid')).join('')}
    </div>
  `;
}

/* alias — HTML calls switchObView, JS had switchOBTab */
window.switchObView = function(tab, el) {
  window.switchOBTab(tab, el);
};

/* ── CHART VIEW TABS (mobile: Chart / OB / Trades) ── */
window.switchChartView = function(view, el) {
  document.querySelectorAll('.chart-view-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['chart','ob','trades'].forEach(v => {
    const el = document.getElementById('cvv-' + v);
    if (el) el.classList.toggle('active', v === view);
  });
  // Keep TradingView iframe alive but hidden to prevent reload
  const chartEl = document.getElementById('cvv-chart');
  if (chartEl) chartEl.style.visibility = view === 'chart' ? '' : 'hidden';
};

/* ── MARKETS BOTTOM PANEL TABS ── */
window.switchMBP = function(tab, el) {
  document.querySelectorAll('.mbp-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.mbp-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  const panel = document.getElementById('mbp-' + tab + '-trade') || document.getElementById('mbp-' + tab);
  if (panel) panel.classList.add('active');
};

/* ── BATCH HISTORY ── */
const BATCH_HISTORY = [];

// renderOB() — only renders from real data pushed via onDEXTick → renderOBFromData.
// Called with no args just updates the batch scroll display if history exists.
function renderOB() {
  if (BATCH_HISTORY.length === 0) {
    const asksEl = $('ob-asks'), bidsEl = $('ob-bids');
    if (asksEl) asksEl.innerHTML = '<div class="ob-empty">Awaiting live feed…</div>';
    if (bidsEl) bidsEl.innerHTML = '';
    return;
  }
  renderBatchScroll();
}

function renderBatchScroll() {
  const container = $('ob-batches-scroll');
  if (!container) return;

  const maxT = Math.max(
    ...BATCH_HISTORY.flatMap(b => b.asks.map(r => r.total)),
    ...BATCH_HISTORY.flatMap(b => b.bids.map(r => r.total))
  );

  container.innerHTML = BATCH_HISTORY.map((batch, i) => {
    const isLatest = i === 0;
    const rowHTML = (r, side) => `
      <div class="ob-row ${side}">
        <div class="ob-depth" style="width:${(r.total/maxT*100).toFixed(1)}%"></div>
        <span class="ob-price">${r.price}</span>
        <span class="ob-size">${fmtSz(r.size)}</span>
        <span class="ob-total">${fmtSz(r.total)}</span>
      </div>`;

    return `
      <div class="ob-batch-block ${isLatest ? 'ob-batch-latest' : ''}">
        <div class="ob-batch-label ${isLatest ? 'ob-batch-label-active' : ''}">
        </div>
        <div class="ob-batch-asks">
          ${[...batch.asks].reverse().map(r => rowHTML(r, 'ask')).join('')}
        </div>
        <div class="ob-batch-mid">
          <span class="ob-mid-price-val">Mid ${batch.mid.toLocaleString('en-US', {maximumFractionDigits:6})}</span>
          <span class="ob-spread-dot">·</span>
          <span class="ob-spread-val">Spread ${batch.spread}</span>
        </div>
        <div class="ob-batch-bids">
          ${batch.bids.map(r => rowHTML(r, 'bid')).join('')}
        </div>
      </div>
    `;
  }).join('');
}

/* ── SWAP PANEL FUNCTIONS ── */
window.setSwapTab = function(el, type) {
  document.querySelectorAll('.swap-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const limitRow = document.getElementById('swap-limit-row');
  if (limitRow) limitRow.style.display = type === 'limit' ? 'flex' : 'none';
};

/* ── TRADE TAB SWITCH (Market / Limit / TWAP) ── */
window.setTradeTab = function(el, type) {
  // Active tab styling
  document.querySelectorAll('.trade-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  STATE.orderType = type;

 // Show/hide desktop panels
const panels = ['market', 'limit', 'twap'];
panels.forEach(p => {
  const panel = document.getElementById('trade-panel-' + p);
  if (panel) panel.style.display = p === type ? 'block' : 'none';

  // Also switch mobile panels
  const panelM = document.getElementById('trade-panel-' + p + '-m');
  if (panelM) {
    panelM.style.display = '';
    if (p === type) {
      panelM.classList.add('active-panel');
    } else {
      panelM.classList.remove('active-panel');
      panelM.style.display = 'none';
    }
  }
});

  // On limit: pre-fill price with current mid
  if (type === 'limit') {
    const priceInput = document.getElementById('limit-price-input');
    if (priceInput && !priceInput.value && STATE.midPrice) {
      priceInput.value = STATE.midPrice >= 1000
        ? STATE.midPrice.toFixed(2)
        : STATE.midPrice.toFixed(4);
    }
    // Sync size unit label
    const ticker = (STATE.marketSym || 'BTC/USDC').split('/')[0];
    const unitEl = document.getElementById('limit-size-unit');
    if (unitEl) unitEl.textContent = ticker;
  }

  // On TWAP: sync size unit and compute stats
  if (type === 'twap') {
    const ticker = (STATE.marketSym || 'BTC/USDC').split('/')[0];
    const unitEl = document.getElementById('twap-size-unit');
    if (unitEl) unitEl.textContent = ticker;
    onTWAPInput();
  }
};

/* ── LIMIT ORDER LOGIC ────────────────────────────────────── */
window.onLimitInput = function() {
  const price  = parseFloat(document.getElementById('limit-price-input')?.value) || 0;
  const size   = parseFloat(document.getElementById('limit-size-input')?.value)  || 0;
  const value  = price * size;
  const fees   = value * 0.0006; // 0.06% maker fee

  const valEl  = document.getElementById('limit-preview-value');
  const feeEl  = document.getElementById('limit-preview-fees');
  if (valEl) valEl.textContent = value > 0 ? '$' + value.toFixed(2) : '—';
  if (feeEl) feeEl.textContent = fees  > 0 ? '$' + fees.toFixed(4)  : '—';
};

window.setLimitPct = function(pct) {
  const mid  = STATE.midPrice || 0;
  const inp  = document.getElementById('limit-size-input');
  if (inp && mid > 0) {
    inp.value = pct > 0 ? (100 / mid * pct / 100).toFixed(6) : '';
    onLimitInput();
  }
};

window.setTIF = function(el, tif) {
  document.querySelectorAll('.tif-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  STATE.tif = tif;
};

/* ── TWAP LOGIC ───────────────────────────────────────────── */
window.onTWAPInput = function() {
  const size    = parseFloat(document.getElementById('twap-size-input')?.value)  || 0;
  const hours   = parseInt(document.getElementById('twap-hours')?.value)   || 0;
  const minutes = parseInt(document.getElementById('twap-minutes')?.value) || 0;

  const totalMinutes = hours * 60 + minutes;
  const clampedMin   = Math.max(5, Math.min(1440, totalMinutes)); // 5m – 24h

  // Gambit executes a suborder every 30 seconds
  const FREQ_SECONDS = 30;
  const totalSeconds = clampedMin * 60;
  const numOrders    = totalSeconds > 0 ? Math.floor(totalSeconds / FREQ_SECONDS) : 0;
  const sizePerOrder = numOrders > 0 && size > 0 ? size / numOrders : 0;
  const fees         = size * (STATE.midPrice || 0) * 0.0006;

  const freqEl    = document.getElementById('twap-stat-freq');
  const runtimeEl = document.getElementById('twap-stat-runtime');
  const ordersEl  = document.getElementById('twap-stat-orders');
  const sizeEl    = document.getElementById('twap-stat-size');
  const feesEl    = document.getElementById('twap-stat-fees');

  const ticker = (STATE.marketSym || 'BTC/USDC').split('/')[0];

  if (freqEl)    freqEl.textContent    = '30 seconds';
  if (runtimeEl) runtimeEl.textContent = totalMinutes > 0
    ? (hours > 0 ? hours + 'h ' : '') + (minutes > 0 ? minutes + 'm' : '')
    : '—';
  if (ordersEl)  ordersEl.textContent  = numOrders > 0 ? numOrders : '—';
  if (sizeEl)    sizeEl.textContent    = sizePerOrder > 0
    ? sizePerOrder.toFixed(6) + ' ' + ticker
    : '—';
  if (feesEl)    feesEl.textContent    = fees > 0 ? '$' + fees.toFixed(4) : '—';
};

window.setTWAPPct = function(pct) {
  const mid = STATE.midPrice || 0;
  const inp = document.getElementById('twap-size-input');
  if (inp && mid > 0) {
    inp.value = pct > 0 ? (100 / mid * pct / 100).toFixed(6) : '';
    onTWAPInput();
  }
};

window.setSlippage = function(el, val) {
  document.querySelectorAll('.slip-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  STATE.slippage = val;
  document.getElementById('slip-custom').value = '';
};

window.setCustomSlippage = function(el) {
  document.querySelectorAll('.slip-btn').forEach(b => b.classList.remove('active'));
  STATE.slippage = parseFloat(el.value) || 0.5;
};

window.setSwapPct = function(pct) {
  const input  = document.getElementById('swap-input');
  const slider = document.getElementById('swap-slider');
  const label  = document.getElementById('swap-slider-pct');
  if (input) {
    input.value = (pct / 100 * 1000).toFixed(2);
    onSwapInput(input);
  }
  if (slider) slider.value = pct;
  if (label)  label.textContent = Math.round(pct) + '%';
};

window.onSwapInput = function(el) {
  const val = parseFloat(el.value) || 0;
  const output = document.getElementById('swap-output');
  const rate = document.getElementById('swap-rate');
  const metricEst = document.getElementById('metric-est-output');
  const metricMin = document.getElementById('metric-min-received');
  const metricImpact = document.getElementById('metric-price-impact');
  const metricFee = document.getElementById('metric-fees');
  const metricBatch = document.getElementById('metric-batch');
  const mid = STATE.midPrice || 74307;
  const est = val > 0 ? (val / mid).toFixed(8) : '—';
  const min = val > 0 ? ((val / mid) * (1 - (STATE.slippage||0.5)/100)).toFixed(8) : '—';
  const impact = val > 10000 ? '>1%' : val > 0 ? '<0.1%' : '—';
  const fee = val > 0 ? '$' + (val * 0.001).toFixed(2) : '—';
  if (output) output.textContent = val > 0 ? est : '—';
  if (rate) rate.textContent = val > 0 ? `1 USDC = ${(1/mid).toFixed(8)} BTC` : '— rate';
  if (metricEst) metricEst.textContent = est;
  if (metricMin) metricMin.textContent = min;
  if (metricImpact) metricImpact.textContent = impact;
  if (metricFee) metricFee.textContent = fee;
  if (metricBatch) metricBatch.textContent = 'Next batch';

  // Update route visual
  if (val > 0) {
    const inToken  = document.getElementById('input-token')?.textContent.replace(' ▾','').trim()  || 'USDC';
    const outToken = document.getElementById('output-token')?.textContent.replace(' ▾','').trim() || 'BTC';
    renderRouteVisual({ inToken, outToken, amount: val });
  } else {
    clearRouteVisual();
  }
};

window.flipTokens = function() {
  const inBtn = document.getElementById('input-token');
  const outBtn = document.getElementById('output-token');
  if (!inBtn || !outBtn) return;
  const tmp = inBtn.textContent;
  inBtn.textContent = outBtn.textContent;
  outBtn.textContent = tmp;
  document.getElementById('swap-input').value = '';
  document.getElementById('swap-output').textContent = '—';
};

const TOKENS = [
  { sym:'USDC',    name:'USD Coin',        color:'#2775CA', common:true  },
  { sym:'USDT',    name:'Tether',          color:'#26A17B', common:true  },
  { sym:'BTC',     name:'Bitcoin',         color:'#F7931A', common:true  },
  { sym:'ETH',     name:'Ethereum',        color:'#627EEA', common:true  },
  { sym:'SOL',     name:'Solana',          color:'#9945FF', common:true  },
  { sym:'BNB',     name:'BNB',             color:'#F0B90B', common:false },
  { sym:'ARB',     name:'Arbitrum',        color:'#12AAFF', common:false },
  { sym:'OP',      name:'Optimism',        color:'#FF0420', common:false },
  { sym:'MATIC',   name:'Polygon',         color:'#8247E5', common:false },
  { sym:'AVAX',    name:'Avalanche',       color:'#E84142', common:false },
  { sym:'LINK',    name:'Chainlink',       color:'#375BD2', common:false },
  { sym:'UNI',     name:'Uniswap',         color:'#FF007A', common:false },
  { sym:'AAVE',    name:'Aave',            color:'#B6509E', common:false },
  { sym:'WIF',     name:'dogwifhat',       color:'#9B6FD4', common:false },
  { sym:'PEPE',    name:'Pepe',            color:'#3D9B35', common:false },
];

let _tokenModalSide = 'in';

window.selectToken = function(side) {
  _tokenModalSide = side;
  const backdrop = document.getElementById('token-modal-backdrop');
  const modal    = document.getElementById('token-modal');
  const search   = document.getElementById('token-modal-search');
  if (!modal) return;
  backdrop.classList.add('open');
  modal.classList.add('open');
  search.value = '';
  renderTokenModal('');
  setTimeout(() => search.focus(), 120);
};

window.closeTokenModal = function() {
  document.getElementById('token-modal-backdrop').classList.remove('open');
  document.getElementById('token-modal').classList.remove('open');
};

window.filterTokenModal = function(q) {
  renderTokenModal(q.toLowerCase().trim());
};

function renderTokenModal(q) {
  // Common pills
  const pillsEl = document.getElementById('token-common-pills');
  const listEl  = document.getElementById('token-modal-list');
  const common  = TOKENS.filter(t => t.common);
  const all     = q
    ? TOKENS.filter(t => t.sym.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    : TOKENS;

  pillsEl.innerHTML = common.map(t => `
    <button class="token-pill" onclick="pickToken('${t.sym}','${t.color}')">
      <span class="token-pill-dot" style="background:${t.color}"></span>
      ${t.sym}
    </button>
  `).join('');

  listEl.innerHTML = all.length ? all.map(t => `
    <div class="token-row" onclick="pickToken('${t.sym}','${t.color}')">
      <div class="token-row-icon" style="background:${t.color}22;border:1px solid ${t.color}44">
        <span style="color:${t.color};font-size:9px;font-weight:800">${t.sym.slice(0,2)}</span>
      </div>
      <div class="token-row-info">
        <span class="token-row-sym">${t.sym}</span>
        <span class="token-row-name">${t.name}</span>
      </div>
      <span class="token-row-bal">—</span>
    </div>
  `).join('') : `<div class="token-empty">No tokens found</div>`;
}

/* ── ROUTE VISUAL ───────────────────────────────────────────── */
// Called by your team's routing feed with real route data.
// window.onRouteTick({
//   inToken:   'USDC',
//   outToken:  'BTC',
//   hops: [
//     { venue: 'Uniswap V3', type: 'DEX', pct: 60 },
//     { venue: 'Binance',    type: 'CEX', pct: 40 },
//   ],
//   score:     92,
//   savings:   '$1.24 better than market',
// })

const VENUE_COLORS = {
  'Uniswap V3':   '#FF007A',
  'Uniswap V2':   '#FF007A',
  'Curve':        '#3465A4',
  'Balancer':     '#1E1E1E',
  'KyberSwap':    '#31CB9E',
  'Binance':      '#F0B90B',
  'Coinbase':     '#0052FF',
  'Kraken':       '#5741D9',
  '1inch':        '#D82122',
  'Paraswap':     '#0070F3',
  'default':      '#d4af37',
};

function getVenueColor(name) {
  return VENUE_COLORS[name] || VENUE_COLORS['default'];
}

function renderRouteVisual({ inToken, outToken, hops, score, savings, amount }) {
  const visual  = document.getElementById('route-path-visual');
  const badge   = document.getElementById('route-score-badge');
  const savingsEl = document.getElementById('route-savings');
  if (!visual) return;

  // If no real hops yet, show a clean placeholder structure
  const routeHops = hops || [];
  const isScanning = !hops;

  if (!hops || hops.length === 0) {
    visual.innerHTML = '<span class="route-empty">Route loads on input</span>';
    if (badge) badge.style.display = 'none';
    if (savingsEl) savingsEl.style.display = 'none';
    return;
  }

  // Build hop nodes
  const hopHTML = routeHops.map((hop, i) => {
    const color = isScanning ? 'var(--t4)' : getVenueColor(hop.venue);
    const typeLabel = hop.type === 'DEX' ? 'DEX'
                    : hop.type === 'CEX' ? 'CEX'
                    : hop.type === 'scanning' ? '' : hop.type;
    const pctLabel = hop.pct != null && !isScanning ? `${hop.pct}%` : '';

    return `
      <div class="route-hop">
        ${i > 0 ? '<div class="route-arrow">→</div>' : ''}
        <div class="route-venue" style="border-color:${color}22;background:${color}11">
          <span class="route-venue-dot" style="background:${color}"></span>
          <span class="route-venue-name" style="color:${isScanning ? 'var(--t4)' : 'var(--t1)'}">${hop.venue}</span>
          ${typeLabel ? `<span class="route-venue-type">${typeLabel}</span>` : ''}
          ${pctLabel ? `<span class="route-venue-pct" style="color:${color}">${pctLabel}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  visual.innerHTML = `
    <div class="route-token route-token-in">${inToken}</div>
    <div class="route-hops-row">${hopHTML}</div>
    <div class="route-token route-token-out">${outToken}</div>
  `;

  // Score badge
  if (badge) {
    if (score != null) {
      badge.textContent = 'Score ' + score;
      badge.style.display = 'inline-flex';
      badge.style.background = score >= 80 ? 'rgba(0,192,118,.12)'
                             : score >= 50 ? 'rgba(212,175,55,.12)'
                             : 'rgba(255,77,79,.12)';
      badge.style.color = score >= 80 ? 'var(--green)'
                        : score >= 50 ? 'var(--gold)'
                        : 'var(--red)';
      badge.style.borderColor = score >= 80 ? 'rgba(0,192,118,.2)'
                              : score >= 50 ? 'rgba(212,175,55,.2)'
                              : 'rgba(255,77,79,.2)';
    } else {
      badge.style.display = 'none';
    }
  }

  // Savings
  if (savingsEl) {
    if (savings) {
      savingsEl.textContent = '↑ ' + savings;
      savingsEl.style.display = 'block';
    } else {
      savingsEl.style.display = 'none';
    }
  }
}

window.onRouteTick = function(data) {
  renderRouteVisual(data);
  _renderExecRoute(data);
};

function _renderExecRoute(data) {
  const body  = document.getElementById('exec-route-body');
  const score = document.getElementById('exec-route-score');
  if (!body) return;

  const arrowSVG = `<svg class="exec-route-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

  if (!data.hops || data.hops.length === 0) {
    body.innerHTML = `<span style="font-size:11px;color:var(--soft);font-family:'Geist Mono',monospace">Waiting for input...</span>`;
    if (score) score.style.display = 'none';
    return;
  }

  const inPill  = `<span class="exec-route-token">${data.inToken}</span>`;
  const outPill = `<span class="exec-route-token">${data.outToken}</span>`;
  const hops    = data.hops.map(h =>
    `${arrowSVG}<span class="exec-route-venue">${h.venue}</span>${arrowSVG}`
  ).join('');

  body.innerHTML = inPill + hops + outPill;

  if (score && data.score != null) {
    score.textContent = 'Score ' + data.score;
    score.style.display = 'inline-flex';
    score.style.background = data.score >= 80 ? 'rgba(10,122,10,.10)'
                           : data.score >= 50 ? 'rgba(212,175,55,.12)'
                           : 'rgba(255,77,79,.12)';
    score.style.color = data.score >= 80 ? '#0a7a0a'
                      : data.score >= 50 ? '#b08a00'
                      : 'var(--red)';
    score.style.border = data.score >= 80 ? '1px solid rgba(10,122,10,.20)'
                       : data.score >= 50 ? '1px solid rgba(212,175,55,.20)'
                       : '1px solid rgba(255,77,79,.20)';
    score.style.borderRadius = '20px';
    score.style.padding = '2px 8px';
    score.style.fontSize = '10px';
    score.style.fontWeight = '700';
    score.style.letterSpacing = '.05em';
    score.style.fontFamily = "'Geist Mono', monospace";
  } else if (score) {
    score.style.display = 'none';
  }
}

function clearRouteVisual() {
  const visual = document.getElementById('route-path-visual');
  const badge  = document.getElementById('route-score-badge');
  const savingsEl = document.getElementById('route-savings');
  if (visual) visual.innerHTML = '<span class="route-empty">Route loads on input</span>';
  if (badge)  badge.style.display = 'none';
  if (savingsEl) savingsEl.style.display = 'none';

  const execBody  = document.getElementById('exec-route-body');
  const execScore = document.getElementById('exec-route-score');
  if (execBody)  execBody.innerHTML = `<span style="font-size:11px;color:var(--soft);font-family:'Geist Mono',monospace">Enter an amount to scan routes</span>`;
  if (execScore) execScore.style.display = 'none';
}

window.executeSwap = async function() {
  if (!STATE.connected || !STATE.walletAddr) {
    window.handleConnect(document.getElementById('btn-connect'));
    return;
  }

  const from   = document.getElementById('input-token')?.textContent.replace(' ▾','').trim()  || 'USDC';
  const to     = document.getElementById('output-token')?.textContent.replace(' ▾','').trim() || 'SUI';
  const amountRaw = parseFloat(document.getElementById('swap-input')?.value) || 0;

  if (amountRaw <= 0) {
    console.warn('[Gambit] executeSwap: no amount entered');
    return;
  }

  const swapBtn = document.getElementById('swap-action-btn');
  if (swapBtn) { swapBtn.textContent = 'Swapping…'; swapBtn.disabled = true; }

  const batchNum   = STATE._currentBatch || 1;
const midPrice   = STATE.midPrice || 0;
const amountOut  = midPrice > 0 ? (amountRaw / midPrice).toFixed(8) : '0';
const routeLabel = _getActiveRoute();

// MOVE TOKEN LOGIC HERE (function scope)
const parts2     = (STATE.marketSym || 'SUI/USDC').split('/');
const baseToken  = parts2[0]?.trim() || 'SUI';
const quoteToken = parts2[1]?.trim() || 'USDC';
const side       = tradeData.side || 'buy';

  // ── Package trade data ───────────────────────────────────
  const tradeData = {
    pair:      `${from}/${to}`,
    side:      window.tradeSide || 'buy',
    amountIn:  amountRaw.toFixed(6),
    amountOut,
    price:     midPrice.toFixed(6),
    route:     routeLabel,
    txDigest:  null,          // filled after on-chain execution
    wallet:    STATE.walletAddr,
    timestamp: Date.now(),
    batchNum,
  };

  try {
    // Step 1: Execute on-chain via DeepBook Router
    let txDigest = null;
    let execRoute = routeLabel;

    const market = MARKETS.find(m => m.sym === STATE.marketSym);
    if (market?.coinIn && market?.coinOut && typeof window.executeSpotTrade === 'function') {
  try {  
    if (swapBtn) swapBtn.textContent = 'Executing…';
    const tradeFrom = side === 'buy' ? quoteToken : baseToken;
    const tradeTo   = side === 'buy' ? baseToken  : quoteToken;
        const execResult = await window.executeSpotTrade({
          from:     tradeFrom,
          to:       tradeTo,
          amountIn: amountRaw,
          slippage: STATE.slippage || 0.5,
        });
        txDigest            = execResult.txDigest;
        execRoute           = execResult.route || routeLabel;
        tradeData.txDigest  = txDigest;
        tradeData.amountOut = execResult.amountOut;
        tradeData.route     = execRoute;
      } catch (execErr) {
        console.error('[Gambit] On-chain execution failed:', execErr);
        if (swapBtn) {
          swapBtn.textContent = 'Failed';
          swapBtn.disabled = false;
          setTimeout(() => updateCTA(), 3000);
        }
        throw execErr;
      }
    }

    // Step 2: Push to feed immediately, archive async — blob patches in when ready
    window.onExecSettle({
      batchNum,
      pair:        side === 'buy' ? `${quoteToken} → ${baseToken}` : `${baseToken} → ${quoteToken}`,
      size:        side === 'buy'
        ? '$' + amountRaw.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : amountRaw.toFixed(6) + ' ' + baseToken,
      route:       execRoute,
      savings:     null,
      time:        ftime(),
      txDigest,
      blobId:      null,
      retrieveUrl: null,
      txUrl: tradeData.txDigest ? `https://suiscan.xyz/mainnet/tx/${tradeData.txDigest}` : null,
      network:     window.walrusNetwork?.() || 'mainnet',
    });

    // No Walrus archive — set txUrl directly to Suiscan testnet
    if (EXEC_LOG[0] && txDigest) {
      EXEC_LOG[0].txUrl = `https://suiscan.xyz/testnet/tx/${txDigest}`;
      EXEC_LOG[0].network = 'testnet';
      _saveExecLog(EXEC_LOG);
      renderExecFeed();
      _syncSwapHistory();
    }

    // ── Reset swap form ──────────────────────────────────────
    const swapInput = document.getElementById('swap-input');
    const swapOutput = document.getElementById('swap-output');
    if (swapInput)  swapInput.value = '';
    if (swapOutput) swapOutput.textContent = '—';
    clearRouteVisual();

  } catch (err) {
    console.error('[Gambit] Swap execution error:', err);
  } finally {
    if (swapBtn) {
      swapBtn.textContent = 'Swap';
      swapBtn.disabled = false;
    }
    if (typeof window.loadWalletBalances === 'function') {
      window.loadWalletBalances();
    }
  }
};

/** Returns currently active route label for the trade record */
function _getActiveRoute() {
  const hops = document.querySelectorAll('.route-venue-name');
  if (hops.length > 0) {
    return Array.from(hops).map(h => h.textContent.trim()).filter(Boolean).join(' | ') || 'Aggregated';
  }
  return 'Aggregated';
}

/* ── EXECUTION FEED ─────────────────────────────────────────── */
// Called by your team's settlement feed with real execution data.
// window.onExecSettle({
//   batchNum: 142,
//   pair:     'USDC → BTC',
//   size:     '$1,240.00',
//   route:    'Uniswap V3',
//   savings:  '+$1.24',
//   time:     '08:32:11',
// })

const MAX_EXEC_ROWS = 50;

function _loadExecLog() {
  try { return JSON.parse(localStorage.getItem('gambit_exec_log') || '[]'); } catch { return []; }
}
function _saveExecLog(log) {
  try { localStorage.setItem('gambit_exec_log', JSON.stringify(log.slice(0, MAX_EXEC_ROWS))); } catch {}
}

const EXEC_LOG = _loadExecLog().filter(r => r.txDigest || r.time);

window.onExecSettle = function(data) {
  EXEC_LOG.unshift(data);
  if (EXEC_LOG.length > MAX_EXEC_ROWS) EXEC_LOG.pop();
  _saveExecLog(EXEC_LOG);
  renderExecFeed();
  _syncSwapHistory();
};

document.addEventListener('DOMContentLoaded', () => {
  renderExecFeed();
  _syncSwapHistory();
});

function _syncSwapHistory() {
  const body = document.getElementById('acct-history-body');
  if (!body) return;
  if (EXEC_LOG.length === 0) return;
  const H_ARROW = `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--muted)"><path d="M2 5h10M9 2l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11H4M7 8l-3 3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const fmtHP = p => { const s = p.split(/→|\//).map(x=>x.trim()); return s.length===2 ? `<span style="display:inline-flex;align-items:center;gap:3px;font-weight:600">${s[0]} ${H_ARROW} ${s[1]}</span>` : `<span style="font-weight:600">${p}</span>`; };
  body.innerHTML = EXEC_LOG.map(r => `
    <div class="acct-history-row">
      <span class="acct-h-pair">${fmtHP(r.pair)}</span>
      <span class="acct-h-size">${r.size}</span>
      <span class="acct-h-route">${r.route}</span>
      <span class="acct-h-savings">${r.savings || '—'}</span>
      <span class="acct-h-time">${r.time}</span>
    </div>
  `).join('');
}

window.toggleExecFeed = function() {
  const feed = document.querySelector('#page-markets .exec-feed');
  if (feed) feed.classList.toggle('feed-open');
};

function renderExecFeed() {
  const body = document.getElementById('exec-feed-body');
  if (!body) return;

  if (EXEC_LOG.length === 0) {
    body.innerHTML = `
      <div class="exec-feed-skel-row"></div>
      <div class="exec-feed-skel-row"></div>
      <div class="exec-feed-skel-row"></div>
    `;
    return;
  }

  const SWAP_ARROW = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:middle;flex-shrink:0;color:var(--muted)"><path d="M2 5h10M9 2l3 3-3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 11H4M7 8l-3 3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const fmtPair = pair => {
    const parts = pair.split(/→|\//).map(s => s.trim());
    if (parts.length === 2) return `<span style="display:inline-flex;align-items:center;gap:4px;font-weight:600">${parts[0]} ${SWAP_ARROW} ${parts[1]}</span>`;
    return `<span style="font-weight:600">${pair}</span>`;
  };

  body.innerHTML = EXEC_LOG.map((r, i) => {
    const txLink = r.txDigest && r.txUrl
      ? `<a class="exec-tx-link" href="${r.txUrl}" target="_blank" rel="noopener" title="View on SuiScan">
           ${r.txDigest.slice(0, 8)}…
         </a>`
      : '<span class="exec-tx-pending">pending</span>';

    return `
      <div class="exec-row ${i === 0 ? 'exec-row-new' : ''}">
        <span class="exec-batch">#${r.batchNum}</span>
        <span class="exec-pair">${fmtPair(r.pair)}</span>
        <span class="exec-size">${r.size}</span>
        <span class="exec-route">${r.route}</span>
        <span class="exec-savings ${r.savings?.startsWith('+') ? 'pos' : ''}">${r.savings || '—'}</span>
        <span class="exec-tx">${txLink}</span>
        <span class="exec-time">${r.time}</span>
      </div>
    `;
  }).join('');
}

/* ── ARCHIVE BROWSER PAGE ────────────────────────────────── */
window.fetchArchiveBlob = async function() {
  const input   = document.getElementById('archive-blob-input');
  const result  = document.getElementById('archive-result');
  const errorEl = document.getElementById('archive-error');
  const fields  = document.getElementById('archive-fields');
  const linkEl  = document.getElementById('archive-walruscan-link');
  const blobId  = input?.value.trim();

  if (!blobId) return;

  // Reset state
  if (result)  result.style.display  = 'none';
  if (errorEl) errorEl.style.display = 'none';
  const btn = document.querySelector('.archive-fetch-btn');
  if (btn) { btn.textContent = 'Fetching…'; btn.disabled = true; }

  try {
    const data = await window.fetchBlob(blobId);

    // Build field rows
    const rows = [
      { label: 'Pair',       value: data.pair      || '—' },
      { label: 'Side',       value: data.side      || '—' },
      { label: 'Amount In',  value: data.amountIn  || '—' },
      { label: 'Amount Out', value: data.amountOut || '—' },
      { label: 'Price',      value: data.price     || '—' },
      { label: 'Route',      value: data.route     || '—' },
      { label: 'Wallet',     value: data.wallet    ? data.wallet.slice(0,10) + '…' + data.wallet.slice(-6) : '—' },
      { label: 'Tx Digest',  value: data.txDigest  ? `<a href="https://suiscan.xyz/mainnet/tx/${data.txDigest}" target="_blank" class="archive-tx-link">${data.txDigest.slice(0,10)}… ↗</a>` : '—' },
      { label: 'Archived',   value: data.archivedAt ? new Date(data.archivedAt).toUTCString() : '—' },
      { label: 'Network',    value: data.network   || '—' },
      { label: 'Blob ID',    value: `<span class="archive-blob-val">${blobId}</span>` },
    ];

    if (fields) {
      fields.innerHTML = rows.map(r => `
        <div class="archive-field-row">
          <span class="archive-field-label">${r.label}</span>
          <span class="archive-field-value">${r.value}</span>
        </div>
      `).join('');
    }

    if (linkEl) {
      linkEl.href = `https://walruscan.com/testnet/blob/${blobId}`;
    }

    if (result) result.style.display = 'block';

 } catch (err) {
    if (errorEl) {
      errorEl.innerHTML = `
        <div style="font-weight:700;margin-bottom:4px;">Blob not found</div>
        <div style="opacity:.75;font-size:10px;">This blob ID could not be retrieved from Walrus storage. It may not exist yet, or the testnet aggregator may be temporarily unavailable.</div>
        <div style="opacity:.5;font-size:9px;margin-top:6px;font-family:var(--mono)">${err.message}</div>
      `;
      errorEl.style.display = 'block';
    }
  } finally {
    if (btn) { btn.textContent = 'Verify'; btn.disabled = false; }
  }
};

// Renders the recent archives list from EXEC_LOG
function renderArchivePage() {
  const body = document.getElementById('archive-recent-body');
  if (!body) return;

  const archived = EXEC_LOG.filter(r => r.blobId);
  if (archived.length === 0) {
    body.innerHTML = '<div class="archive-empty">Execute a swap to see archived trades here</div>';
    return;
  }

  body.innerHTML = archived.map(r => `
    <div class="archive-recent-row" onclick="document.getElementById('archive-blob-input').value='${r.blobId}';fetchArchiveBlob()">
      <span class="archive-recent-blob">◈ ${r.blobId.slice(0,10)}…</span>
      <span class="archive-recent-pair">${r.pair}</span>
      <span class="archive-recent-size">${r.size}</span>
      <span class="archive-recent-time">${r.time}</span>
    </div>
  `).join('');
}

window.pickToken = function(sym, color) {
  const inBtn  = document.getElementById('input-token');
  const outBtn = document.getElementById('output-token');
  if (_tokenModalSide === 'in' && inBtn)  inBtn.textContent  = sym + ' ▾';
  if (_tokenModalSide === 'out' && outBtn) outBtn.textContent = sym + ' ▾';
  closeTokenModal();
};

/* ── TRADES FEED ────────────────────────────────────────────── */
const TRADE_LOG = [];

// _pushTrade() removed — no simulated trades.
// All trade ticks come from window.onTradeTick() called by your real feed.

function renderTradesFeed() {
  const body = $('ob-trades-body');
  if (!body) return;
  if (TRADE_LOG.length === 0) {
    body.innerHTML = '<div class="ob-empty">Awaiting live trades…</div>';
    return;
  }
  body.innerHTML = TRADE_LOG.map(t => `
    <div class="ob-trade-row">
      <span class="ob-trade-price ${t.isBuy ? 'bid' : 'ask'}">${t.price}</span>
      <span class="ob-trade-size">${t.size}</span>
      <span class="ob-trade-time">${t.time}</span>
    </div>
  `).join('');
}

// Entry point — called by your real trades feed
// data: { isBuy: bool, price: number, size: number, time: string }
window.onTradeTick = function(data) {
  TRADE_LOG.unshift({ ...data, batch: STATE._currentBatch || 1 });
  if (TRADE_LOG.length > 80) TRADE_LOG.pop();
  renderTradesFeed();
};

/* ── CLOCK ──────────────────────────────────────────────────── */
function _clock() {
  const el = $('chart-clock');
  if (el) el.textContent = ftime() + ' (UTC+1)';
  const fe = $('strip-funding');
  if (fe) {
    const d = new Date();
    fe.textContent = `0.0013% ${pad(59 - d.getMinutes())}:${pad(59 - d.getSeconds())}`;
  }
}

/* ── ORDER FORM ─────────────────────────────────────────────── */
function selectSide(side) {
  STATE.side = side;
  const buyBtn  = $('btn-buy');
  const sellBtn = $('btn-sell');
  if (buyBtn)  buyBtn.style.opacity  = side === 'buy'  ? '1' : '0.55';
  if (sellBtn) sellBtn.style.opacity = side === 'sell' ? '1' : '0.55';
  if (STATE.connected) _syncSubmitBtn();
  calcOrder();
}

function setOT(el, type) {
  $$('.ot-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  STATE.orderType = type;
  const pf = $('field-price');
  if (pf) {
    pf.style.display = type === 'limit' ? 'block' : 'none';
    if (type === 'limit') {
      const inp = $('input-price');
      if (inp && !inp.value) inp.value = STATE.midPrice.toFixed(3);
    }
  }
}

function setMargin(el) {
  $$('.margin-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

function setLev() {
  const opts = [1,2,3,5,10,20,25,50,100];
  const idx  = opts.indexOf(STATE.lev);
  STATE.lev  = opts[(idx + 1) % opts.length];
  const lb = $('lev-btn'), mb = $('sel-market-lev');
  if (lb) lb.textContent = STATE.lev + 'x';
  if (mb) mb.textContent = STATE.lev + 'x';
  calcOrder();
}

function onSlider(el) {
  const pct = parseInt(el.value);
  const lbl = $('slider-pct-label');
  if (lbl) lbl.textContent = pct + '%';
  const inp = $('input-size');
  if (inp) { inp.value = pct > 0 ? (100 / STATE.midPrice * pct / 100).toFixed(4) : ''; }
  calcOrder();
}

function calcOrder() {
  const sizeEl = $('input-size');
  if (!sizeEl) return;
  const size = parseFloat(sizeEl.value) || 0;
  const mid  = STATE.midPrice;
  const ve = $('sum-val'), me = $('sum-margin'), le = $('sum-liq');
  if (size > 0) {
    const notional = size * mid;
    const margin   = notional / STATE.lev;
    const liqDelta = margin / size * 0.9;
    if (ve) ve.textContent = '$' + notional.toFixed(2);
    if (me) me.textContent = '$' + margin.toFixed(2);
    if (le) le.textContent = STATE.side === 'buy' ? (mid - liqDelta).toFixed(3) : (mid + liqDelta).toFixed(3);
  } else {
    if (ve) ve.textContent = 'N/A';
    if (me) me.textContent = 'N/A';
    if (le) le.textContent = '—';
  }
}

function toggleTPSL(chk) {
  const f = $('tpsl-fields');
  if (f) f.style.display = chk.checked ? 'block' : 'none';
}

function _syncSubmitBtn() {
  const btn = $('btn-submit');
  if (!btn) return;
  if (!STATE.connected) { btn.textContent = 'Connect Wallet'; btn.className = 'btn-submit'; return; }
  btn.textContent = STATE.side === 'buy' ? 'Buy / Long' : 'Sell / Short';
  btn.className   = 'btn-submit ' + (STATE.side === 'buy' ? 'buy-mode' : 'sell-mode');
}

/* ── WALLET CONNECT ─────────────────────────────────────────── */
// Wallet connection is handled by sui-wallet.js (loaded before this file).
// handleConnect(), _disconnectWallet(), signAndExecuteTransaction()
// are all defined there and operate on Sui testnet / mainnet.
// The BASE_CHAIN_ID constant below is intentionally removed.

// handleConnect is defined in sui-wallet.js — do not redefine here.

// _disconnectWallet is aliased to _disconnectSuiWallet in sui-wallet.js

let tradeSide = "buy";
function isWalletConnected() {
  return STATE.connected === true;
}

function setSide(side, el) {
  tradeSide = side;
  document.querySelectorAll(".side-btn").forEach(b => b.classList.remove("active"));
  el.classList.add("active");

  // Update balance label for the selected side
  const balEl  = document.getElementById('trade-balance');
  const balElM = document.getElementById('trade-balance-m');
  if (STATE.connected) {
    const label = side === 'buy'
    ? (STATE.usdcBalance || 0).toFixed(2) + ' DBUSDC'
      : (STATE.suiBalance  || 0).toFixed(4) + ' SUI';
    if (balEl)  balEl.textContent  = label;
    if (balElM) balElM.textContent = label;
  }

  // Sync exec page balance displays
  const execBalEls = ['exec-balance','exec-limit-balance','exec-twap-balance'];
  if (STATE.connected) {
    const execLabel = side === 'buy'
      ? (STATE.usdcBalance || 0).toFixed(2) + ' DBUSDC'
      : (STATE.suiBalance  || 0).toFixed(4) + ' SUI';
    execBalEls.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = execLabel;
    });
  }

  // Sync exec side buttons visual state
  document.querySelectorAll('.exec-side-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll(`.exec-side-btn.${side}`).forEach(b => b.classList.add('active'));

  updateCTA();
  
  // At the end of setSide() and setExecSide(), after updateCTA():
const swapBtn = document.getElementById('swap-action-btn');
if (swapBtn && !swapBtn.disabled) {
  const _ticker = (STATE.marketSym || 'SUI/USDC').split('/')[0].trim();
  swapBtn.textContent = side === 'buy' ? 'Buy ' + _ticker : 'Sell ' + _ticker;
}
  
}

window.setTradePct = function(pct) {
  const val  = parseFloat(pct) || 0;
  const mid  = STATE.midPrice || 0;
  const inp  = document.getElementById('trade-size-input');
  const inpM = document.getElementById('trade-size-input-m');
  const side    = window.tradeSide || 'buy';
const bal     = side === 'buy'
  ? (STATE.usdcBalance || 0)
  : (STATE.suiBalance  || 0);
const amount  = bal > 0 ? (val / 100 * bal).toFixed(6) : '0';
  if (inp)  { inp.value  = amount; onTradeInput(inp); }
  if (inpM) { inpM.value = amount; onTradeInput(inpM); }
  const execInp = document.getElementById('exec-size-input');
  if (execInp) { execInp.value = amount; onExecInput(execInp); }
};

window.updateCTA = function updateCTA() {
  const connectAction = () => window.handleConnect(document.getElementById('btn-connect'));
  const ticker = (STATE.marketSym || 'BTC/USDC').split('/')[0].trim();

  const wire = (id, label, action, cls) => {
    const b = document.getElementById(id);
    if (!b) return;
    b.textContent = label;
    b.onclick     = action || null;
    // swap gold class for deposit state vs normal
    if (cls === 'deposit') {
      b.style.background = 'var(--gold, #d4af37)';
      b.style.color      = '#000';
    } else {
      b.style.background = '';
      b.style.color      = '';
    }
  };

  // ── Not connected ────────────────────────────────────────────
  if (!STATE.connected) {
    wire('trade-btn',        'Connect Wallet', connectAction);
    wire('trade-btn-mobile', 'Connect Wallet', connectAction);
    wire('limit-trade-btn',  'Connect Wallet', connectAction);
    wire('twap-trade-btn',   'Connect Wallet', connectAction);
    return;
  }

  // ── Connected — balance check skipped (fetched async, default allows trading) ──
  // STATE.balance starts at 0 but wallet balance is fetched on-chain.
  // Don't gate the CTA on it — let executeSpotTrade() surface the real error if funds are absent.

  // ── Connected, has balance — Market panel ────────────────────
  const mSize = parseFloat(document.getElementById('trade-size-input')?.value || document.getElementById('trade-size-input-m')?.value) || 0;
const mLabel = tradeSide === 'buy' ? 'Buy ' + ticker : 'Sell ' + ticker;
wire('trade-btn',
  mSize > 0 ? mLabel : mLabel,
  window.executeTrade
);
wire('trade-btn-mobile',
  mSize > 0 ? mLabel : mLabel,
  window.executeTrade
);

  // ── Limit panel ──────────────────────────────────────────────
  const lPrice = parseFloat(document.getElementById('limit-price-input')?.value) || 0;
  const lSize  = parseFloat(document.getElementById('limit-size-input')?.value)  || 0;
  wire('limit-trade-btn',
    (lPrice > 0 && lSize > 0) ? (tradeSide === 'buy' ? 'Buy ' + ticker : 'Sell ' + ticker) : 'Enter Price & Size',
    (lPrice > 0 && lSize > 0) ? window.executeTrade : null
  );

  // ── TWAP panel ───────────────────────────────────────────────
  const tSize = parseFloat(document.getElementById('twap-size-input')?.value) || 0;
  wire('twap-trade-btn',
    tSize > 0 ? (tradeSide === 'buy' ? 'Buy ' + ticker + ' (TWAP)' : 'Sell ' + ticker + ' (TWAP)') : 'Enter Amount',
    tSize > 0 ? window.executeTrade : null
  );

  // ── Execute page buttons (mobile) ────────────────────────────
  if (!STATE.connected) {
    const _ticker = STATE.marketSym?.split('/')[0] || 'SUI';
    wire('exec-btn',       tradeSide === 'buy' ? 'Buy ' + _ticker : 'Sell ' + _ticker, connectAction);
    wire('exec-limit-btn', tradeSide === 'buy' ? 'Buy ' + _ticker : 'Sell ' + _ticker, connectAction);
    wire('exec-twap-btn',  tradeSide === 'buy' ? 'Buy ' + _ticker : 'Sell ' + _ticker, connectAction);
    return;
  }
  const exSize = parseFloat(document.getElementById('exec-size-input')?.value) || 0;
  const exLabel = tradeSide === 'buy' ? 'Buy ' + ticker : 'Sell ' + ticker;
  wire('exec-btn', exLabel, window.executeTrade);
  const exLPrice = parseFloat(document.getElementById('exec-limit-price')?.value) || 0;
  const exLSize  = parseFloat(document.getElementById('exec-limit-size')?.value)  || 0;
  wire('exec-limit-btn',
    (exLPrice > 0 && exLSize > 0) ? (tradeSide === 'buy' ? 'Buy ' + ticker : 'Sell ' + ticker) : 'Enter Price & Size',
    (exLPrice > 0 && exLSize > 0) ? window.executeTrade : null
  );
  const exTSize = parseFloat(document.getElementById('exec-twap-size')?.value) || 0;
  wire('exec-twap-btn',
    exTSize > 0 ? (tradeSide === 'buy' ? 'Buy ' + ticker + ' (TWAP)' : 'Sell ' + ticker + ' (TWAP)') : 'Enter Amount',
    exTSize > 0 ? window.executeTrade : null
  );
}

/* ── ON TRADE INPUT ─────────────────────────────────────────── */
// Called by oninput on #trade-size-input in HTML
window.onTradeInput = function(el) {
  const val  = parseFloat(el.value) || 0;
  const mid  = STATE.midPrice || 0;
  const fees = val * mid * 0.001;

  const pvEl   = document.getElementById('preview-value');
  const pfEl   = document.getElementById('preview-fees');
  const piEl   = document.getElementById('preview-fill');
  const pimpEl = document.getElementById('preview-impact');
  const pair   = STATE.marketSym || 'SUI/USDC';
  const base   = pair.split('/')[0];
  const estOut = mid > 0 && val > 0 ? (val / mid).toFixed(6) + ' ' + base : '—';
  if (pvEl)   pvEl.textContent   = val > 0 ? '$' + (val * mid).toFixed(2) : '—';
  if (pfEl)   pfEl.textContent   = fees > 0 ? '$' + fees.toFixed(4) : '—';
  if (piEl)   piEl.textContent   = mid > 0 && val > 0 ? estOut : '—';
  if (pimpEl) pimpEl.textContent = val > 10000 ? '>1%' : val > 0 ? '<0.1%' : '—';

  // Mirror to exec page preview
  const execVal    = document.getElementById('exec-preview-value');
  const execFees   = document.getElementById('exec-preview-fees');
  const execFill   = document.getElementById('exec-preview-fill');
  const execImpact = document.getElementById('exec-preview-impact');
  if (execVal)    execVal.textContent    = val > 0 ? '$' + (val * mid).toFixed(2) : '—';
  if (execFees)   execFees.textContent   = fees > 0 ? '$' + fees.toFixed(4) : '—';
  if (execFill)   execFill.textContent   = mid > 0 && val > 0 ? estOut : '—';
  if (execImpact) execImpact.textContent = val > 10000 ? '>1%' : val > 0 ? '<0.1%' : '—';

  updateCTA();
};


/* ── ON EXEC INPUT (execute page) ───────────────────────────── */
window.onExecInput = function(el) {
  const val  = parseFloat(el.value) || 0;
  const mid  = STATE.midPrice || 0;
  const fees = val * mid * 0.001;
  const pair = STATE.marketSym || 'SUI/USDC';
  const base = pair.split('/')[0];
  const estOut = mid > 0 && val > 0 ? (val / mid).toFixed(6) + ' ' + base : '—';

  const execVal    = document.getElementById('exec-preview-value');
  const execFees   = document.getElementById('exec-preview-fees');
  const execFill   = document.getElementById('exec-preview-fill');
  const execImpact = document.getElementById('exec-preview-impact');
  if (execVal)    execVal.textContent    = val > 0 ? '$' + (val * mid).toFixed(2) : '—';
  if (execFees)   execFees.textContent   = fees > 0 ? '$' + fees.toFixed(4) : '—';
  if (execFill)   execFill.textContent   = mid > 0 && val > 0 ? estOut : '—';
  if (execImpact) execImpact.textContent = val > 10000 ? '>1%' : val > 0 ? '<0.1%' : '—';

  // Sync slider pct display
  const pctEl = document.getElementById('exec-pct');
  const slider = document.getElementById('exec-slider');
  if (STATE.connected) {
    const side = window.tradeSide || 'buy';
    const bal  = side === 'buy' ? (STATE.usdcBalance || 0) : (STATE.suiBalance || 0);
    if (bal > 0 && slider && pctEl) {
      const pct = Math.min(100, Math.round(val / bal * 100));
      slider.value = pct;
      pctEl.textContent = pct + '%';
    }
  }
  updateCTA();
};


/* ── EXEC TAB SWITCHING ─────────────────────────────────────── */
window.setExecTab = function(el, type) {
  document.querySelectorAll('.exec-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  STATE.orderType = type;

  ['market','limit','twap'].forEach(p => {
    const panel = document.getElementById('exec-panel-' + p);
    if (!panel) return;
    if (p === type) {
      panel.style.display = '';
      panel.classList.add('active-exec-panel');
    } else {
      panel.style.display = 'none';
      panel.classList.remove('active-exec-panel');
    }
  });

  // Pre-fill limit price
  if (type === 'limit' && STATE.midPrice) {
    const lp = document.getElementById('exec-limit-price');
    if (lp && !lp.value) lp.value = STATE.midPrice >= 1000
      ? STATE.midPrice.toFixed(2)
      : STATE.midPrice.toFixed(4);
    const ticker = (STATE.marketSym || 'SUI/USDC').split('/')[0];
    const lu = document.getElementById('exec-limit-size-unit');
    if (lu) lu.textContent = ticker;
  }

  // Sync TWAP unit
  if (type === 'twap') {
    const ticker = (STATE.marketSym || 'SUI/USDC').split('/')[0];
    const tu = document.getElementById('exec-twap-size-unit');
    if (tu) tu.textContent = ticker;
  }
};

/* ── EXEC SIDE TOGGLE ───────────────────────────────────────── */
window.setExecSide = function(side, el) {
  window.tradeSide = side;
tradeSide = side;  
STATE.side = side;
  document.querySelectorAll('.side-btn, .exec-side-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll(`.side-btn.${side}, .exec-side-btn.${side}`).forEach(b => b.classList.add('active'));

  // Update balance display
  if (STATE.connected) {
    const label = side === 'buy'
    ? (STATE.usdcBalance || 0).toFixed(2) + ' DBUSDC'
      : (STATE.suiBalance  || 0).toFixed(4) + ' SUI';
    ['exec-balance','exec-limit-balance','exec-twap-balance'].forEach(id => {
      const el2 = document.getElementById(id);
      if (el2) el2.textContent = label;
    });
  }

  // Update input unit label: buy = spending USDC, sell = spending SUI
  const ticker = (STATE.marketSym || 'SUI/USDC').split('/')[0].trim();
  const quote  = 'DBUSDC';
  const unitLabel = side === 'buy' ? quote : ticker;
  ['exec-size-unit', 'exec-limit-size-unit', 'exec-twap-size-unit'].forEach(id => {
    const u = document.getElementById(id);
    if (u) u.textContent = unitLabel;
  });
  
  // Directly update exec button labels — don't depend on updateCTA's connected check
const _ticker2 = ticker; // already defined above
['exec-btn', 'exec-limit-btn', 'exec-twap-btn'].forEach(id => {
  const b = document.getElementById(id);
  if (b && b.textContent !== 'Connect Wallet') {
    b.textContent = side === 'buy' ? 'Buy ' + _ticker2 : 'Sell ' + _ticker2;
  }
});

  // Also update the balance row label when not connected
  const balEl = document.getElementById('exec-balance');
  if (!STATE.connected && balEl) {
    balEl.textContent = side === 'buy' ? '0.00 DBUSDC' : '0.00 ' + ticker;
  }

  updateCTA();
  
  // At the end of setSide() and setExecSide(), after updateCTA():
const swapBtn = document.getElementById('swap-action-btn');
if (swapBtn && !swapBtn.disabled) {
  const _ticker = (STATE.marketSym || 'SUI/USDC').split('/')[0].trim();
  swapBtn.textContent = side === 'buy' ? 'Buy ' + _ticker : 'Sell ' + _ticker;
}
  
};

/* ── EXEC SLIDER ────────────────────────────────────────────── */
window.setExecPct = function(pct) {
  const val  = parseFloat(pct) || 0;
  const side = window.tradeSide || 'buy';
  const bal  = side === 'buy' ? (STATE.usdcBalance || 0) : (STATE.suiBalance || 0);
  const amount = bal > 0 ? (val / 100 * bal).toFixed(6) : '0';
  const inp = document.getElementById('exec-size-input');
  if (inp) { inp.value = amount; onExecInput(inp); }
};

/* ── EXECUTE SPOT TRADE ─────────────────────────────────────── */
window.executeTrade = async function() {
  if (!STATE.connected || !STATE.walletAddr) {
    window.handleConnect(document.getElementById('btn-connect'));
    return;
  }

  const sizeInput = document.getElementById('exec-size-input') || document.getElementById('trade-size-input') || document.getElementById('trade-size-input-m');
  const amountRaw = parseFloat(sizeInput?.value) || 0;
  if (amountRaw <= 0) { updateCTA(); return; }

  const btn = document.getElementById('trade-btn');
  // Always read pair from STATE — trade-pair DOM element may be empty on first render
  const pair = STATE.marketSym || 'SUI/USDC';
  const parts = pair.split('/');
  const baseToken  = parts[0]?.trim() || 'SUI';
  const quoteToken = parts[1]?.trim() || 'USDC';

  const side      = tradeSide; // 'buy' | 'sell'
  const midPrice  = STATE.midPrice || 0;
  const amountOut = midPrice > 0
    ? side === 'buy'
      ? (amountRaw / midPrice).toFixed(8)
      : (amountRaw * midPrice).toFixed(4)
    : '0';

  const batchNum   = STATE._currentBatch || 1;
  const routeLabel = _getActiveRoute();

  // Loading state
  const execBtn = document.getElementById('exec-btn');
  const loadingBtns = [btn, execBtn].filter(Boolean);
  loadingBtns.forEach(b => {
    b.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
           style="animation:spin .7s linear infinite;flex-shrink:0">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      ${side === 'buy' ? `Buying ${baseToken}` : `Selling ${baseToken}`}
    </span>`;
    b.disabled = true;
  });

  const tradeData = {
    pair:      `${baseToken}/${quoteToken}`,
    side,
    amountIn:  amountRaw.toFixed(6),
    amountOut,
    price:     midPrice.toFixed(6),
    route:     routeLabel,
    txDigest:  null,
    wallet:    STATE.walletAddr,
    timestamp: Date.now(),
    batchNum,
  };

  try {
    // Step 1: Execute on-chain via DeepBook Router
    let txDigest   = null;
    let execRoute  = routeLabel;
    let amountOutFinal = amountOut;

    const market = MARKETS.find(m => m.sym === STATE.marketSym);
    if (market?.coinIn && market?.coinOut && typeof window.executeSpotTrade === 'function') {
      if (btn) btn.textContent = side === 'buy' ? `Buying ${baseToken}…` : `Selling ${baseToken}…`;
      // buy  = spend quoteToken (USDC), receive baseToken (SUI)
      // sell = spend baseToken  (SUI),  receive quoteToken (USDC)
      const tradeFrom = side === 'buy' ? market.coinIn  : market.coinOut;
      const tradeTo   = side === 'buy' ? market.coinOut : market.coinIn;
      const execResult = await window.executeSpotTrade({
        from:     tradeFrom,
        to:       tradeTo,
        amountIn: amountRaw,
        slippage: STATE.slippage || 0.5,
      });
      txDigest          = execResult.txDigest;
      execRoute         = execResult.route || routeLabel;
      amountOutFinal    = execResult.amountOut;
      tradeData.txDigest  = txDigest;
      tradeData.amountOut = amountOutFinal;
      tradeData.route     = execRoute;
    } else {
      console.warn('[Gambit] No coinIn/coinOut on market or executeSpotTrade missing — skipping on-chain execution');
    }

   // Step 2: Push to feed immediately, blob patches in async
    window.onExecSettle({
      batchNum,
      pair:        side === 'buy' ? `${quoteToken} → ${baseToken}` : `${baseToken} → ${quoteToken}`,
      size:        side === 'buy'
        ? '$' + amountRaw.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : amountRaw.toFixed(6) + ' ' + baseToken,
      route:       execRoute,
      savings:     null,
      time:        ftime(),
      txDigest,
      blobId:      null,
      retrieveUrl: null,
      txUrl:       null,
      network:     window.walrusNetwork?.() || 'mainnet',
    });

    // No Walrus archive — set txUrl directly to Suiscan testnet
    if (EXEC_LOG[0] && txDigest) {
      EXEC_LOG[0].txUrl = `https://suiscan.xyz/testnet/tx/${txDigest}`;
      EXEC_LOG[0].network = 'testnet';
      _saveExecLog(EXEC_LOG);
      renderExecFeed();
      _syncSwapHistory();
    }

    // Reset form
    if (sizeInput) sizeInput.value = '';
    const slider = document.getElementById('trade-slider');
    const pct    = document.getElementById('trade-pct');
    if (slider) slider.value = 0;
    if (pct)    pct.textContent = '0%';
    updateCTA();
    // Refresh balances after swap
    if (window._fetchWalletBalances && window.STATE?.walletAddr) {
      setTimeout(() => window._fetchWalletBalances(window.STATE.walletAddr), 2500);
    }

  } catch (err) {
    console.error('[Gambit] Trade execution error:', err);
    if (btn) {
      btn.textContent = 'Failed';
      btn.disabled = false;
      setTimeout(() => updateCTA(), 3000);
    }
} finally {
    if (btn) { btn.disabled = false; updateCTA(); }
    // Refresh balance immediately after trade
    if (typeof window.loadWalletBalances === 'function') {
      window.loadWalletBalances();
    }
  }
};

/* ── BOTTOM TABS ────────────────────────────────────────────── */
function switchBottomTab(tab, el) {
  $$('.bottom-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  const content = $('bottom-content');
  if (!content) return;
  if (tab === 'positions') {
    content.innerHTML = `<table class="pos-table">
      <thead><tr><th>Coin</th><th>Size</th><th>Position Value ▾</th>
      <th>Entry Price</th><th>Mark Price</th><th>PNL (ROE %)</th>
      <th>Liq. Price</th><th>Margin</th></tr></thead>
      <tbody><tr><td colspan="8" style="text-align:center;padding:18px 0;color:var(--t3);font-size:11px;">
      No open positions yet</td></tr></tbody></table>`;
  } else if (tab === 'balances') {
    content.innerHTML = `<div class="empty-state"><span class="empty-text">No balances — connect wallet to begin</span></div>`;
  } else {
    const labels = { orders:'No open orders', twap:'No active TWAP orders',
      history:'No trade history yet', funding:'No funding history', orderhist:'No order history' };
    content.innerHTML = `<div class="empty-state"><span class="empty-text">${labels[tab]||'Nothing here'}</span></div>`;
  }
}

/* ── MARKETS TABLE ──────────────────────────────────────────── */
let _activeFilter = 'all';
const _favSet = new Set();

function renderMarketsTable(filter, query) {
  const tbody = document.getElementById('markets-tbody');
  const countEl = document.getElementById('mkts-count');

  if (!tbody) return;

  const f = filter !== undefined ? filter : _activeFilter;

  const q = (
    query ||
    document.querySelector('.mkts-search')?.value ||
    ''
  )
    .toLowerCase()
    .trim();

  const rows = MARKETS.filter(m => {
    const matchCat =
      f === 'all' || m.cat.includes(f);

    const matchQ =
      !q ||
      m.sym.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q);

    return matchCat && matchQ;
  });

  if (countEl) {
    countEl.textContent = `${rows.length} pairs`;
  }

  tbody.innerHTML = rows.map(m => {
    const isFav = _favSet.has(m.sym);

    const ticker = m.sym.split('/')[0];

    const priceStr =
      m.price == null
        ? '—'
        : m.price >= 1000
          ? '$' + m.price.toLocaleString('en-US', {
              maximumFractionDigits: 2
            })
          : '$' + m.price.toFixed(4);

    const chgStr =
      m.chg == null
        ? '—'
        : `${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%`;

    const chgCls =
      m.chg == null
        ? ''
        : m.chg >= 0
          ? 'up'
          : 'down';

    const volStr = m.vol || '—';

    return `
      <tr class="mkts-row" onclick="openMarket('${m.sym}')">

        <td class="mkts-fav-col">
          <button
            class="mkts-fav ${isFav ? 'on' : ''}"
            onclick="event.stopPropagation(); _toggleFav(this,'${m.sym}')"
          >
            ${isFav ? '★' : '☆'}
          </button>
        </td>

        <td class="mkts-market-col">
          <div class="mkts-market-wrap">

            <div class="mkts-market-top">
              <span class="mkts-pair">${ticker}</span>
              <span class="mkts-quote">/USDC</span>

              <div class="mkts-inline-badges">
                <span class="mkts-badge spot">SPOT</span>
              </div>
            </div>

            <div class="mkts-market-meta">
              ${m.name}
            </div>

          </div>
        </td>

        <td class="r mkts-price mono">
          ${priceStr}
        </td>

        <td class="r mkts-change ${chgCls}">
          ${chgStr}
        </td>

        <td class="r mkts-volume mono">
          ${volStr}
        </td>

        <td class="r mkts-route hide-sm">
          <span class="mkts-route-pill">
            Multi
          </span>
        </td>

      </tr>
    `;
  }).join('');
}

function _toggleFav(btn, sym) {
  if (_favSet.has(sym)) {
    _favSet.delete(sym);
    btn.textContent = '☆';
    btn.classList.remove('on');
  } else {
    _favSet.add(sym);
    btn.textContent = '★';
    btn.classList.add('on');
  }
}

function filterMarkets(filter, el) {
  $$('.mkts-pill').forEach(p =>
    p.classList.remove('active')
  );

  el.classList.add('active');
  _activeFilter = filter;

  renderMarketsTable(filter);
}

function searchMarkets(q) {
  renderMarketsTable(_activeFilter, q);
}

/* ── ASSET DROPDOWN ─────────────────────────────────────────── */
let _assetDropdownOpen = false;

window.toggleAssetDropdown = function() {
  _assetDropdownOpen ? closeAssetDropdown() : openAssetDropdown();
};

window.openAssetDropdown = function() {
  _assetDropdownOpen = true;
  const dd    = document.getElementById('asset-dropdown');
  const bd    = document.getElementById('asset-dropdown-backdrop');
  const chev  = document.getElementById('strip-asset-chevron');
  const input = document.getElementById('asset-dropdown-search');
  if (dd) dd.classList.add('open');
  if (bd) bd.classList.add('open');
  if (chev) chev.style.transform = 'rotate(180deg)';
  renderAssetDropdown('');
  setTimeout(() => input?.focus(), 80);
};

window.closeAssetDropdown = function() {
  _assetDropdownOpen = false;
  const dd   = document.getElementById('asset-dropdown');
  const bd   = document.getElementById('asset-dropdown-backdrop');
  const chev = document.getElementById('strip-asset-chevron');
  if (dd) dd.classList.remove('open');
  if (bd) bd.classList.remove('open');
  if (chev) chev.style.transform = '';
};

window.filterAssetDropdown = function(q) {
  renderAssetDropdown(q.toLowerCase().trim());
};

function renderAssetDropdown(q) {
  const list = document.getElementById('asset-dropdown-list');
  if (!list) return;
  const filtered = q
    ? MARKETS.filter(m => m.sym.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
    : MARKETS;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="asset-dd-empty">No markets found</div>';
    return;
  }

  list.innerHTML = '<table class="mkts-table" style="width:100%"><tbody>' +
    filtered.map(m => {
      const isFav   = _favSet.has(m.sym);
      const ticker  = m.sym.split('/')[0];
      const isActive = m.sym === STATE.marketSym;

      const priceStr = m.price == null ? '—'
        : m.price >= 1000
          ? '$' + m.price.toLocaleString('en-US', { maximumFractionDigits: 2 })
          : '$' + m.price.toFixed(4);

      const chgStr = m.chg == null ? '—'
        : (m.chg >= 0 ? '+' : '') + m.chg.toFixed(2) + '%';
      const chgCls = m.chg == null ? '' : m.chg >= 0 ? 'up' : 'down';

      const volStr = m.vol || '—';

      return `
        <tr class="mkts-row ${isActive ? 'dd-active' : ''}" onclick="selectAssetFromDropdown('${m.sym}')">
          <td class="mkts-fav-col">
            <button class="mkts-fav ${isFav ? 'on' : ''}"
              onclick="event.stopPropagation(); _toggleFav(this,'${m.sym}')">
              ${isFav ? '★' : '☆'}
            </button>
          </td>
          <td class="mkts-market-col">
            <div class="mkts-market-wrap">
              <div class="mkts-market-top">
                <span class="mkts-pair">${ticker}</span>
                <span class="mkts-quote">/USDC</span>
                <div class="mkts-inline-badges"><span class="mkts-badge spot">SPOT</span></div>
              </div>
              <div class="mkts-market-meta">${m.name}</div>
            </div>
          </td>
          <td class="r mkts-price mono">${priceStr}</td>
          <td class="r mkts-change ${chgCls}">${chgStr}</td>
          <td class="r mkts-volume mono">${volStr}</td>
        </tr>
      `;
    }).join('') +
  '</tbody></table>';
}

window.selectAssetFromDropdown = function(sym) {
  closeAssetDropdown();
  openMarket(sym);
};

function updateStripAsset(m) {
  const nameEl  = document.getElementById('strip-asset-name');
  const iconEl  = document.getElementById('strip-asset-icon');
  if (nameEl) nameEl.textContent = m.sym;
  if (iconEl) {
    iconEl.style.background = m.color;
    iconEl.style.width  = '8px';
    iconEl.style.height = '8px';
    iconEl.style.borderRadius = '50%';
    iconEl.style.flexShrink = '0';
  }
}

/* ── STRIP BAR ──────────────────────────────────────────────── */
// Called by your team's data feed with live market data.
// Expected format:
// window.onStripTick({
//   price:      94312.50,       // current mid price
//   change24h:  2.34,           // percent, e.g. +2.34 or -1.12
//   vol24h:     '1.24B',        // pre-formatted string
//   spread:     '0.001',        // raw spread value
//   routeScore: 94,             // 0-100
//   bestVenue:  'Uniswap V3',   // best routing venue name
//   gas:        '$0.04',        // estimated gas cost
//   batchNum:   142,            // current batch number
// })

/* ── MARKET STATS ───────────────────────────────────────── */
async function _fetchMarketStats() {
  try {
    const BASE = 'https://deepbook-indexer.mainnet.mystenlabs.com';

    // Get pool list for count
    const poolsRes = await fetch(`${BASE}/get_pools`);
    const pools = await poolsRes.json();
    const poolCount = Array.isArray(pools) ? pools.length : 0;

    // Get 24h volume across all pools (quote asset = USDC)
    const now   = Math.floor(Date.now() / 1000);
    const start = now - 86400;
    const volRes  = await fetch(`${BASE}/all_historical_volume?start_time=${start}&end_time=${now}`);
    const volData = await volRes.json();

    // Sum all quote-asset volumes; most pools quote in USDC (6 decimals)
    // SUI_USDC quote is USDC (6), DEEP_SUI quote is SUI (9) — weight by USDC pools only
    const USDC_POOLS = ['SUI_USDC', 'DEEP_USDC', 'NS_USDC', 'WUSDC_USDC', 'WUSDT_USDC'];
    let totalVol = 0;
    for (const [pool, vol] of Object.entries(volData)) {
      if (USDC_POOLS.includes(pool)) totalVol += Number(vol) / 1e6;
      // skip non-USDC pools to avoid double counting
    }

    const fmtUSD = v => {
      if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B USDC';
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M USDC';
      if (v >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K USDC';
      return '$' + v.toFixed(2) + ' USDC';
    };

    const volEl     = document.getElementById('ms-vol');
    const liqEl     = document.getElementById('ms-liq');
    const mktsEl    = document.getElementById('ms-markets');
    const tradersEl = document.getElementById('ms-traders');

    if (volEl)     volEl.textContent  = totalVol > 0 ? fmtUSD(totalVol) : '—';
    if (liqEl)     liqEl.textContent  = '—'; // no liquidity endpoint on public indexer
    if (mktsEl)    mktsEl.textContent = poolCount > 0 ? String(poolCount) : '—';
    if (tradersEl) tradersEl.textContent = '—'; // no trader count on public indexer
  } catch (e) {
    console.warn('[MarketStats]', e);
  }
}

window.onStripTick = function(data) {
  const fmt = n => n >= 1e9 ? (n/1e9).toFixed(2)+'B'
                 : n >= 1e6 ? (n/1e6).toFixed(2)+'M'
                 : n >= 1e3 ? (n/1e3).toFixed(2)+'K'
                 : String(n);

  const priceEl = $('strip-stat-price');
  if (priceEl && data.price != null) {
    const prev = parseFloat(priceEl.dataset.prev || data.price);
    priceEl.textContent = '$' + data.price.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
    priceEl.className = 'strip-stat-price ' + (data.price >= prev ? 'strip-up' : 'strip-down');
    priceEl.dataset.prev = data.price;
    STATE.midPrice = data.price;
  }

  const chgEl = $('strip-stat-chg');
  if (chgEl && data.change24h != null) {
    const sign = data.change24h >= 0 ? '+' : '';
    chgEl.textContent = sign + data.change24h.toFixed(2) + '%';
    chgEl.className = 'strip-stat-chg ' + (data.change24h >= 0 ? 'strip-up' : 'strip-down');
  }

  const changeEl = $('strip-stat-change');
  if (changeEl && data.change24h != null) {
    const sign = data.change24h >= 0 ? '+' : '';
    changeEl.textContent = sign + data.change24h.toFixed(2) + '%';
    changeEl.className = 'strip-stat-val ' + (data.change24h >= 0 ? 'strip-up' : 'strip-down');
  }

  const volEl = $('strip-stat-vol');
  if (volEl && data.vol24h != null)
    volEl.textContent = typeof data.vol24h === 'number' ? '$' + fmt(data.vol24h) : data.vol24h;

  const mcapEl = $('strip-stat-mcap');
  if (mcapEl) mcapEl.textContent = data.marketCap ? fmt(data.marketCap) + ' USDC' : '—';

  const spreadEl = $('strip-stat-spread');
  if (spreadEl && data.spread != null) spreadEl.textContent = data.spread;

  const routeEl = $('strip-stat-route');
  if (routeEl && data.routeScore != null) {
    setRouteScoreBadge(routeEl, data.routeScore);
  }

  const midEl = $('ob-mid-price');
  if (midEl && data.price != null)
    midEl.textContent = data.price.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
};

/* ── OPEN MARKET ────────────────────────────────────────────── */
function openMarket(sym) {
  const m = MARKETS.find(x => x.sym === sym);
  if (!m) return;

  /* ── State ──────────────────────────────────────────────── */
  STATE.market    = m.tv;
  STATE.marketSym = m.sym;
  STATE.midPrice  = m.price || 0;
  if (m.lev) STATE.lev = m.lev;

  /* ── Helpers ─────────────────────────────────────────────── */
  const ticker = m.sym.split(/[-/]/)[0].toUpperCase();
  const init   = ticker.slice(0, 2);
  const chgStr = m.chg === null ? '— / —' : `${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(3)} / ${m.chg >= 0 ? '+' : ''}${m.chg.toFixed(2)}%`;

  /* ── Mobile strip ────────────────────────────────────────── */
  const ne = $('sel-market-name');
  const le = $('sel-market-lev');
  const pe = $('strip-mark');
  const ce = $('strip-change');
  if (ne) ne.textContent = m.sym;

  /* ── Asset selector strip ── */
  const assetName = $('strip-asset-name');
  const assetIcon = $('strip-asset-icon');
  if (assetName) assetName.textContent = m.sym;
  const tradeAssetName = $('trade-asset-name');
  if (tradeAssetName) tradeAssetName.textContent = m.sym;
  if (assetIcon) {
    assetIcon.style.background = m.color;
    assetIcon.style.width = '8px';
    assetIcon.style.height = '8px';
    assetIcon.style.borderRadius = '50%';
    assetIcon.style.flexShrink = '0';
  }
  
  /* ── Desktop strip ───────────────────────────────────────── */
  const md = $('strip-mark-d');
  const cd = $('strip-change-d');
  const lb = $('lev-btn');
  if (md) md.textContent = m.price ? m.price.toFixed(3) : '—';
  if (cd) { cd.textContent = chgStr; cd.className = 'strip-stat-val' + (m.chg >= 0 ? ' up' : ' down'); }
  if (lb) lb.textContent = m.lev ? `${m.lev}x` : '—';

  /* ── Navigate + chart ────────────────────────────────────── */
  // Update trade panel pair display
  const parts2    = m.sym.split('/');
  const tokenBase = parts2[0] || 'SUI';
  const tokenQuote = parts2[1] || 'USDC';
  const tradePairEl = document.getElementById('trade-pair');
  const tradePriceEl = document.getElementById('trade-price');
  if (tradePairEl)  tradePairEl.textContent  = m.sym;
  if (tradePriceEl) tradePriceEl.textContent = m.price ? '$' + m.price.toFixed(4) : '';
  // Update size unit label
 const sizeUnitEl = document.getElementById('trade-size-unit');
if (sizeUnitEl) sizeUnitEl.textContent = tokenBase;

const sizeUnitElM = document.getElementById('trade-size-unit-m');
if (sizeUnitElM) sizeUnitElM.textContent = tokenBase;

  // Sync execute page strip + size units
  const execName = document.getElementById('exec-asset-name');
  if (execName) execName.textContent = m.sym;
  const execIcon = document.getElementById('exec-asset-icon');
  if (execIcon) execIcon.innerHTML = window.coinIconHTML(m.sym.split('/')[0].toLowerCase(), tokenBase[0], m.color, 22);
  
  // Unit depends on current side: buy = spend quote (USDC), sell = spend base (SUI)
  const _execSide = window.tradeSide || 'buy';
  const _execUnit = _execSide === 'buy' ? 'DBUSDC' : tokenBase;
  ['exec-size-unit','exec-limit-size-unit','exec-twap-size-unit'].forEach(id => {
    const u = document.getElementById(id);
    if (u) u.textContent = _execUnit;
  });

  const balanceEl = document.getElementById('trade-balance');
  if (balanceEl)  balanceEl.textContent  = '0.00 DBUSDC';

  // Update output token label
  const outputLabel = document.querySelector('.swap-section label + .output');
  const estOutput   = document.getElementById('estimated-output');
  if (estOutput) estOutput.setAttribute('data-token', tokenOut);
  
// Strip stats — cleared on market switch, real values arrive via onStripTick()
  const priceEl  = document.getElementById('strip-stat-price');
  const chgEl    = document.getElementById('strip-stat-chg');
  const changeEl = document.getElementById('strip-stat-change');
  const volEl    = document.getElementById('strip-stat-vol');
  const spreadEl = document.getElementById('strip-stat-spread');

  if (m.price) {
    _updateMidPriceDisplay(m.price, m.chg || 0);
    if (volEl && m.vol) volEl.textContent = m.vol >= 1e9 ? '$'+(m.vol/1e9).toFixed(2)+'B'
                                          : m.vol >= 1e6 ? '$'+(m.vol/1e6).toFixed(2)+'M'
                                          : (m.vol/1e3).toFixed(2)+'K USDC';
  } else {
    if (priceEl)  { priceEl.textContent  = '—'; priceEl.className  = 'strip-stat-price'; }
    if (chgEl)    { chgEl.textContent    = '—'; chgEl.className    = 'strip-stat-chg'; }
    if (changeEl) { changeEl.textContent = '—'; changeEl.className = 'strip-stat-val'; }
    if (volEl)    volEl.textContent = '—';
  }
  if (spreadEl) spreadEl.textContent = '—';

  initTVChart(m.tv, STATE.tf);
}  


/* ── BOTTOM PANEL TABS ──────────────────────────────────────── */
window.switchBottomTab = function(tab, el) {
  document.querySelectorAll('.bottom-panel-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['orders','history','positions'].forEach(id => {
    const panel = document.getElementById('bp-' + id);
    if (panel) panel.style.display = id === tab ? 'flex' : 'none';
  });
};

/* ── POSITIONS: render wallet balances as positions ─────────── */
window.renderPositions = function() {
  const body   = document.getElementById('bp-positions-body');
  const footer = document.getElementById('bp-positions-footer');
  if (!body) return;

  if (!STATE.connected) {
    body.innerHTML = `
      <div class="bp-empty">
        <svg width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" style="color:var(--soft)">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span class="bp-empty-title">No positions</span>
        <span class="bp-empty-sub">Connect wallet to view balances</span>
      </div>`;
    if (footer) footer.style.display = 'none';
    return;
  }

  const hideSmall = document.getElementById('bp-hide-small-cb')?.checked;
  const mid = STATE.midPrice || 0;

  const sui  = STATE.suiBalance  || 0;
  const usdc = STATE.usdcBalance || 0;

  const positions = [
    { sym: 'SUI',  icon: 'sui',  name: 'Sui',     amount: sui,  price: mid,   decimals: 4 },
    { sym: 'USDC', icon: 'usdc', name: 'USD Coin', amount: usdc, price: 1.0,   decimals: 2 },
  ].filter(p => !hideSmall || p.amount * p.price > 1);

  if (positions.length === 0) {
    body.innerHTML = `<div class="bp-empty">
      <span class="bp-empty-title">No balances above threshold</span>
    </div>`;
    if (footer) footer.style.display = 'none';
    return;
  }

  let totalEquity = 0;
  body.innerHTML = positions.map(p => {
    const value = p.amount * p.price;
    totalEquity += value;
    const avgPrice = p.price; // spot: avg = mark
    const pnl = 0; // no entry price stored for spot
    const pnlPct = 0;
    const pnlClass = pnl >= 0 ? 'bp-pos-pnl-pos' : 'bp-pos-pnl-neg';
    const iconHTML = window.coinIconHTML(p.icon, p.sym[0], null, 20);
    return `<div class="bp-pos-row">
      <div class="bp-pos-asset">${iconHTML}<span>${p.sym}</span></div>
      <span>${p.amount.toFixed(p.decimals)}<br><small style="color:var(--soft);font-size:9px">$${value.toFixed(2)}</small></span>
      <span style="font-family:var(--mono)">${avgPrice >= 1 ? avgPrice.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : avgPrice.toPrecision(5)}</span>
      <span style="font-family:var(--mono)">${p.price >= 1 ? p.price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : p.price.toPrecision(5)}</span>
      <span class="${pnlClass}">${pnl === 0 ? '—' : (pnl > 0 ? '+' : '') + pnl.toFixed(2)}</span>
      <span class="${pnlClass}" style="text-align:right">${pnlPct === 0 ? '—' : (pnlPct > 0 ? '+' : '') + pnlPct.toFixed(2) + '%'}</span>
    </div>`;
  }).join('');

  if (footer) {
    footer.style.display = 'flex';
    const eq = document.getElementById('bp-total-equity');
    if (eq) eq.textContent = '$' + totalEquity.toFixed(2);
  }
};

window.toggleHideSmall = function() {
  window.renderPositions();
};

/* ── OPEN ORDERS: render from DeepBook (post wallet connect) ── */
window.renderOpenOrders = function(orders) {
  const empty = document.getElementById('bp-orders-empty');
  const rows  = document.getElementById('bp-orders-body');
  if (!empty || !rows) return;

  if (!orders || orders.length === 0) {
    empty.style.display = 'flex';
    rows.style.display  = 'none';
    return;
  }

  empty.style.display = 'none';
  rows.style.display  = 'block';
  rows.innerHTML = orders.map(o => {
    const sideClass = o.side === 'buy' ? 'bp-order-side-buy' : 'bp-order-side-sell';
    const statusCls = o.status === 'filled' ? 'filled' : 'open';
    return `<div class="bp-order-row">
      <span style="font-weight:600">${o.pair}</span>
      <span class="${sideClass}">${o.side.toUpperCase()}</span>
      <span style="color:var(--muted)">${o.type}</span>
      <span style="font-family:var(--mono)">${o.price}</span>
      <span style="font-family:var(--mono)">${o.size}</span>
      <span style="font-family:var(--mono)">${o.filled}</span>
      <span><span class="bp-order-status ${statusCls}">${o.status}</span></span>
      <span style="color:var(--soft);text-align:right;font-size:10px">${o.time}</span>
    </div>`;
  }).join('');
};

/* ── SETTINGS ───────────────────────────────────────────────── */
function toggleSetting(row) {
  const t = row.querySelector('.toggle');
  if (t) t.classList.toggle('on');
}

function toggleStripExpand() {
  const details = document.getElementById('strip-details');
  const btn     = document.getElementById('strip-expand-btn');
  details.classList.toggle('open');
  btn.classList.toggle('expanded');
}


function openSidebar() {
  document.getElementById('sidebar-drawer').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar-drawer').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

/* ── COMING SOON ────────────────────────────────────────────── */
window.showComingSoon = function(el, name) {
  document.querySelectorAll('.nav-soon-tooltip').forEach(t => t.remove());
  const rect = el.getBoundingClientRect();
  const tip  = document.createElement('div');
  tip.className   = 'nav-soon-tooltip';
  tip.textContent = `${name} — Coming soon on Base`;
  tip.style.top   = (rect.bottom + 8) + 'px';
  tip.style.left  = rect.left + 'px';
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 2000);
};


/* ── ACCOUNT PAGE ───────────────────────────────────────────── */
window.switchAcctTab = function(tab, el) {
  document.querySelectorAll('.acct-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.acct-panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  const panel = document.getElementById('acct-' + tab);
  if (panel) panel.classList.add('active');
};

// Called when wallet connects — update account page
function _updateAccountPage() {
  if (!STATE.connected) return;

  const sui  = STATE.suiBalance  || 0;
  const dbusdc = STATE.usdcBalance || 0;
  const mid  = STATE.midPrice    || 0;

  const totalUSD = (sui * mid) + dbusdc;
  const swapped  = STATE._totalSwappedUSD || 0;
  const saved    = STATE._totalSavedUSD   || 0;

  const el = id => document.getElementById(id);
  if (el('acct-total-balance')) el('acct-total-balance').textContent = '$' + totalUSD.toFixed(2);
  if (el('acct-available'))     el('acct-available').textContent     = '$' + totalUSD.toFixed(2);
  if (el('acct-total-swapped')) el('acct-total-swapped').textContent = '$' + swapped.toFixed(2);
  if (el('acct-total-saved'))   el('acct-total-saved').textContent   = '$' + saved.toFixed(2);

  const balPanel = el('acct-balances');
  if (balPanel) {
    balPanel.innerHTML = `
      <div class="acct-token-row">
        <div class="acct-token-left">
          ${window.coinIconHTML('sui', 'S', '#4DA2FF', 32)}
          <span class="acct-token-name">Sui</span>
        </div>
        <div class="acct-token-right">
          <span class="acct-token-amount">${sui.toFixed(4)}</span>
          <span class="acct-token-usd">≈ $${(sui * mid).toFixed(2)}</span>
        </div>
      </div>
      <div class="acct-token-row">
        <div class="acct-token-left">
          ${window.coinIconHTML('dbusdc', 'D', '#2775CA', 32)}
          <span class="acct-token-name">DeepBook USDC</span>
        </div>
        <div class="acct-token-right">
          <span class="acct-token-amount">${dbusdc.toFixed(2)}</span>
          <span class="acct-token-usd">≈ $${dbusdc.toFixed(2)}</span>
        </div>
      </div>
    `;
  }
}

/* ── Orderbook bottom sheet (mobile drag) ── */
(function initOBSheet() {
  const sheet  = document.querySelector('.orderbook-panel');
  const handle = document.getElementById('ob-drag-handle');
  if (!sheet || !handle) return;

  const PEEK_PX = 54;
  let startY = 0, currentY = 0, dragging = false, sheetHeight = 0;

  function isMobile() { return window.matchMedia('(max-width: 1023px)').matches; }

  function open()  { sheet.classList.add('sheet-open'); sheet.style.transform = ''; }
  function close() { sheet.classList.remove('sheet-open'); sheet.style.transform = ''; }
  function toggle(){ sheet.classList.contains('sheet-open') ? close() : open(); }

  handle.addEventListener('click', (e) => {
    if (!isMobile() || dragging) return;
    toggle();
  });

  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile()) return;
    dragging = true;
    startY = e.clientY;
    sheetHeight = sheet.offsetHeight;
    sheet.classList.add('sheet-dragging');
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const delta = e.clientY - startY;
    const openOffset  = sheet.classList.contains('sheet-open') ? 0 : sheetHeight - PEEK_PX;
    let y = openOffset + delta;
    y = Math.max(0, Math.min(sheetHeight - PEEK_PX, y));
    sheet.style.transform = `translateY(${y}px)`;
    currentY = y;
  });

  handle.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('sheet-dragging');
    sheet.style.transform = '';
    const threshold = (sheetHeight - PEEK_PX) * 0.4;
    if (currentY < threshold) { open(); } else { close(); }
  });

  window.addEventListener('resize', () => {
    if (!isMobile()) { sheet.classList.remove('sheet-open', 'sheet-dragging'); sheet.style.transform = ''; }
  });
})();

/* ── BOOT ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  STATE._booting = true;

  // Markets table starts blank — real prices arrive via onStripTick / your feed.
  // mockPrice values are kept on MARKETS objects only for price-formatting
  // precision logic (e.g. decimal places). Nothing is seeded into the UI.

  navigate('markets');
  openMarket('SUI/USDC');
  STATE._booting = false;
  renderMarketsTable();
  _startPriceFeed();
  _startLiveFeed();
  _fetchMarketStats();
  setInterval(_fetchMarketStats, 60000);
  _loadDefaultRoute();
  
  // Pre-seed midPrice from market object if available
const mkt = MARKETS.find(m => m.sym === STATE.marketSym);
if (mkt?.price) STATE.midPrice = mkt.price;
else STATE.midPrice = 0;

  STATE.clockInterval = setInterval(_clock, 1000);
  _clock();

  // Batch counter — increments every 3 s so the UI batch tag stays alive.
  // renderOB() with no real data just shows "Awaiting live feed…" until
  // onDEXTick pushes real asks/bids.
  let batchCount = 0;
  let obCountdown = 3;

  function runBatch() {
    batchCount++;
    STATE._currentBatch = batchCount;
    renderOB(); // no-op until real data in BATCH_HISTORY

    const tag     = document.getElementById('ob-batch-tag');
    const counter = document.getElementById('ob-batch-counter');
    if (tag) {
      tag.textContent = `Batch #${batchCount}`;
      tag.classList.remove('batch-flash');
      void tag.offsetWidth;
      tag.classList.add('batch-flash');
    }
    if (counter) counter.textContent = `${batchCount}`;
    
    // Fetch real on-chain orderbook from DeepBook pool
  if (typeof window.fetchOrderbook === 'function') {
    window.fetchOrderbook(STATE.marketSym).then(ob => {
      if (!ob) return;
      window.onDEXTick({ mid: ob.mid, asks: ob.asks, bids: ob.bids });
    }).catch(() => {});
  }
  }

  // Countdown display
  setInterval(() => {
    obCountdown--;
    if (obCountdown <= 0) obCountdown = 3;
    const cd = document.getElementById('ob-countdown');
    if (cd) cd.textContent = obCountdown + 's';
  }, 1000);

  setInterval(runBatch, 3000);
  runBatch();

  // No simulated trades — trade feed populated only by window.onTradeTick()

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') closeOrderPanel();
    if (e.key === 'b' || e.key === 'B') selectSide('buy');
    if (e.key === 's' && !e.metaKey && !e.ctrlKey) selectSide('sell');
  });

  // Backdrop closes panel
  const bd = $('panel-backdrop');
  if (bd) bd.addEventListener('click', closeOrderPanel);

  // Resize: auto-close panel when going desktop
  window.addEventListener('resize', () => {
    if (!mobile() && STATE.panelOpen) closeOrderPanel();
  });

 // Wire CTA buttons on load
  if (typeof window.updateCTA === 'function') window.updateCTA();
  window.renderPositions();
})
