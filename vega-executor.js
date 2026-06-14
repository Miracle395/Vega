/* ================================================================
   GAMBIT DEX — trade-executor.js  v1.0
   Spot trade execution layer.

   Flow:
     1. Get a route quote from Aftermath Finance Router (mainnet)
     2. Build the transaction block from the quote
     3. Sign via the connected Sui wallet (sui-wallet.js)
     4. Broadcast via Tatum Sui RPC
     5. Return txDigest → gambit.js → archiveTrade() → Walrus

   Load order in index.html:
     walrus.js → sui-wallet.js → trade-executor.js → gambit.js

   Dependencies:
     - window.STATE.walletAddr    (set by sui-wallet.js on connect)
     - window.STATE.suiWallet     (set by sui-wallet.js on connect)
     - window.signAndExecuteTransaction  (defined in sui-wallet.js)
     - aftermath-ts-sdk           (loaded from CDN via ESM shim below)
================================================================ */
'use strict';

/* ── NETWORK + TATUM CONFIG ──────────────────────────────────── */
const EXECUTOR_CONFIG = {
  network: 'TESTNET',

  TESTNET: {
    tatumRpc:   'https://sui-testnet.gateway.tatum.io',
    tatumKey:   't-6a1314026dcffd29f3321133-b2b7fb9669494fdebadaf640',
    // Native USDC on Sui testnet (Circle)
    USDC: '0x65b0553a591d7b13376e03a408e112c706dc0909a79080c810b93b06f922c458::usdc::USDC',
    SUI:  '0x2::sui::SUI',
  },

  MAINNET: {
    tatumRpc:   'https://sui-mainnet.gateway.tatum.io',
    tatumKey:   't-6a1314026dcffd29f3321133-cb8c2fb42a924934a367b95b',
    // Native USDC on Sui mainnet (Circle)
    USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    SUI:  '0x2::sui::SUI',
  },
};

function _execCfg() {
  return EXECUTOR_CONFIG[EXECUTOR_CONFIG.network];
}

/* ── COIN TYPE RESOLVER ──────────────────────────────────────── */
/**
 * Maps Gambit token symbols (e.g. 'SUI', 'USDC') to
 * their full Sui coin type strings for the active network.
 */
function _resolveCoinType(sym) {
  const cfg = _execCfg();
  const map = {
    'SUI':  cfg.SUI,
    'USDC': cfg.USDC,
  };
  const resolved = map[sym.toUpperCase()];
  if (!resolved) {
    throw new Error(`[Executor] Unknown token symbol: ${sym}. Add it to _resolveCoinType().`);
  }
  return resolved;
}

/* ── DEEPBOOK SDK LOADER ──────────────────────────────────────── */
/**
 * @mysten/deepbook-v3 + @mysten/sui are loaded as ES modules from CDN.
 * Cached so they only load once per session.
 */
let _dbModulesPromise = null;

async function _loadDeepBookModules() {
  if (_dbModulesPromise) return _dbModulesPromise;

  _dbModulesPromise = (async () => {
    const [dbMod, suiClientMod, { Transaction }] = await Promise.all([
  import('https://esm.sh/@mysten/deepbook-v3'), 
   import('https://esm.sh/@mysten/sui@latest/dist/client/index.js'),
   
  import('https://esm.sh/@mysten/sui/transactions'),
]);
const DeepBookClient = dbMod.DeepBookClient;
const SuiClient = suiClientMod.CoreClient;

console.log('[Executor] dbMod keys:', Object.keys(dbMod));
console.log('[Executor] suiMod keys:', Object.keys(suiClientMod));
console.log('[Executor] DeepBook SDK modules loaded');
return { DeepBookClient, SuiClient, Transaction };
  })();

  return _dbModulesPromise;
}


window.executeSpotTrade = async function({ from, to, amountIn, slippage = 0.5 }) {
  const wallet     = window.STATE?.suiWallet;
  const walletAddr = window.STATE?.walletAddr;

  if (!wallet || !walletAddr) {
    throw new Error('Wallet not connected');
  }

  console.log(`[Executor] Starting DeepBook swap: ${amountIn} ${from} → ${to}`);

  /* ── Resolve pool + direction ────────────────────────────── */
  const { poolKey, isBaseIn } = _resolvePoolAndSide(from, to);

  /* ── Load DeepBook SDK ────────────────────────────────────── */
  let DeepBookClient, SuiClient, Transaction;
try {
  ({ DeepBookClient, SuiClient, Transaction } = await Promise.race([
      _loadDeepBookModules(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DeepBook SDK load timed out after 30s')), 30000)
      ),
    ]));
  } catch (sdkErr) {
    throw new Error(`Routing unavailable — ${sdkErr.message}. Check connection and retry.`);
  }

  const network = EXECUTOR_CONFIG.network === 'TESTNET' ? 'testnet' : 'mainnet';

const suiClient = new SuiClient({ url: `https://fullnode.${network}.sui.io:443` });
const dbClient = new DeepBookClient({ address: walletAddr, env: network, client: suiClient });

  /* ── Estimate output from live mid-price (order book already streaming) ── */
  const midPrice = window.STATE?.midPrice || 0;
  if (!midPrice) {
    throw new Error('[Executor] No live price available, wait for order book to load');
  }
  const amountOutEst = isBaseIn ? amountIn * midPrice : amountIn / midPrice;
  const minOut = amountOutEst * (1 - slippage / 100);

  /* ── Build swap transaction ───────────────────────────────── */
  const tx = new Transaction();
try {
  let baseOut, quoteOut, deepOut;
  if (isBaseIn) {
    [baseOut, quoteOut, deepOut] = dbClient.deepBook.swapExactBaseForQuote({
      poolKey,
      amount: amountIn,
      deepAmount: 0,
      minOut,
    })(tx);
  } else {
    [baseOut, quoteOut, deepOut] = dbClient.deepBook.swapExactQuoteForBase({
      poolKey,
      amount: amountIn,
      deepAmount: 0,
      minOut,
    })(tx);
  }
  tx.transferObjects([baseOut, quoteOut, deepOut], walletAddr);
} catch (buildErr) {
  throw new Error(`[Executor] DeepBook tx build failed: ${buildErr.message}`);
}

  /* ── Sign + broadcast via existing wallet flow ────────────── */
  let txDigest;
  try {
    txDigest = await window.signAndExecuteTransaction(tx);
  } catch (signErr) {
    throw new Error(`[Executor] Wallet signing failed: ${signErr.message}`);
  }

  if (!txDigest) {
    throw new Error('[Executor] No txDigest returned from wallet');
  }

  console.log(`[Executor] DeepBook swap settled ✓  txDigest: ${txDigest}`);

  return {
    txDigest,
    amountOut: amountOutEst.toFixed(8),
    route: _buildRouteLabel(),
  };
};

/* ── POOL/SIDE RESOLVER ───────────────────────────────────────── */
/**
 * Maps a Cairn from→to pair to a DeepBook poolKey + swap direction.
 * Extend this map as you add more pairs.
 */
function _resolvePoolAndSide(from, to) {
  const F = from.toUpperCase(), T = to.toUpperCase();

  // DeepBook testnet default pool: SUI_DBUSDC (base = SUI, quote = DBUSDC)
  if (F === 'SUI'  && T === 'USDC') return { poolKey: 'SUI_DBUSDC', isBaseIn: true  };
  if (F === 'USDC' && T === 'SUI')  return { poolKey: 'SUI_DBUSDC', isBaseIn: false };

  throw new Error(`[Executor] No DeepBook pool configured for ${from} → ${to}`);
}

/* ── ROUTE LABEL ──────────────────────────────────────────────── */
function _buildRouteLabel() {
  return 'DeepBook CLOB';
}

/* ── NETWORK SWITCH (kept in sync with walrus.js + sui-wallet.js) ── */
window.executorSetNetwork = function(n) {
  const key = n.toUpperCase();
  if (key !== 'MAINNET' && key !== 'TESTNET') {
    throw new Error('executorSetNetwork: must be "mainnet" or "testnet"');
  }
  EXECUTOR_CONFIG.network = key;
  // Reset SDK cache so it reinitialises on the new network
  _dbModulesPromise = null;
  console.log(`[Executor] Network set to ${key}`);
};

/* ── LIVE ORDERBOOK FROM AFTERMATH POOL ─────────────────────── */
window.fetchOrderbook = async function(sym) {
  return null;
};

