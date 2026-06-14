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
    const [dbMod, { SuiClient }, { Transaction }] = await Promise.all([
      import('https://esm.sh/@mysten/deepbook-v3'),
      
      import('https://esm.sh/@mysten/sui@latest'),
      import('https://esm.sh/@mysten/sui/transactions'),
    ]);
    const DeepBookClient = dbMod.DeepBookClient;
    console.log('[Executor] DeepBook SDK modules loaded');
    return { DeepBookClient, SuiClient, Transaction, dbMod };
  })();

  return _dbModulesPromise;
}

/* ── BALANCE MANAGER CACHE ───────────────────────────────────── */
// DeepBook V3 requires a BalanceManager object registered on-chain.
// We create one per session and cache its ID in sessionStorage.
let _balanceManagerId = null;

async function _getOrCreateBalanceManager(dbClient, tx, walletAddr) {
  if (_balanceManagerId) return _balanceManagerId;

  // createAndShareBalanceManager returns the manager object in the tx
  const manager = dbClient.balanceManager.createAndShareBalanceManager()(tx);
  // The manager ID is only known after execution — we return a sentinel
  // and re-read from effects after the first tx settles.
  return manager;
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
  let DeepBookClient, SuiClient, Transaction, dbMod;
  try {
    ({ DeepBookClient, SuiClient, Transaction, dbMod } = await Promise.race([
      _loadDeepBookModules(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DeepBook SDK load timed out after 30s')), 30000)
      ),
    ]));
  } catch (sdkErr) {
    throw new Error(`Routing unavailable — ${sdkErr.message}. Check connection and retry.`);
  }

  const network  = EXECUTOR_CONFIG.network === 'TESTNET' ? 'testnet' : 'mainnet';
  const rpcUrl   = network === 'mainnet'
    ? 'https://fullnode.mainnet.sui.io:443'
    : 'https://fullnode.testnet.sui.io:443';

 // Use SuiClient (JSON-RPC) not SuiGrpcClient — needed for tx.build()
  const { getFullnodeUrl, SuiClient: SuiJsonClient } = await import('https://esm.sh/@mysten/sui@latest');
  const suiClient = new SuiJsonClient({ url: rpcUrl });

  const packageIds = network === 'testnet' ? dbMod.testnetPackageIds : dbMod.mainnetPackageIds;
  const pools      = network === 'testnet' ? dbMod.testnetPools      : dbMod.mainnetPools;
  const coins      = network === 'testnet' ? dbMod.testnetCoins      : dbMod.mainnetCoins;

  const dbClient = new DeepBookClient({
    address:    walletAddr,
    client:     suiClient,
    packageIds,
    pools,
    coins,
  });

  /* ── Get or create BalanceManager ────────────────────────── */
  const tx = new Transaction();
  tx.setSender(walletAddr);

  let managerKey = 'MANAGER_1';

  // If we have a cached manager ID, inject it; otherwise create one inline.
  // DeepBook SDK lets you pass a managerKey that maps to a stored ID.
  if (_balanceManagerId) {
    dbClient.balanceManager.balanceManagers[managerKey] = {
      address:   _balanceManagerId,
      tradeCap:  undefined,
    };
  } else {
    // First run — create the manager in this tx
    dbClient.balanceManager.createAndShareBalanceManager()(tx);
    // We can't know the ID until after execution, so we fall through
    // and handle it in the post-execution step below.
    managerKey = null;
  }

  /* ── Estimate minOut from live mid-price ─────────────────── */
  const midPrice = window.STATE?.midPrice || 0;
  if (!midPrice) {
    throw new Error('[Executor] No live price available — wait for order book to load');
  }
  const amountOutEst = isBaseIn ? amountIn * midPrice : amountIn / midPrice;
  const minOut       = amountOutEst * (1 - slippage / 100);

  /* ── Build the market order (only if manager already exists) ── */
  if (managerKey) {
    if (isBaseIn) {
      dbClient.deepBook.swapExactBaseForQuote({
        poolKey,
        balanceManagerKey: managerKey,
        amount:            amountIn,
        minOut,
        deepAmount:        0,
        payWithDeep:       false,
      })(tx);
    } else {
      dbClient.deepBook.swapExactQuoteForBase({
        poolKey,
        balanceManagerKey: managerKey,
        amount:            amountIn,
        minOut,
        deepAmount:        0,
        payWithDeep:       false,
      })(tx);
    }
  }

  /* ── Sign + broadcast ────────────────────────────────────── */
  let txDigest;
  try {
    const builtTx = await tx.build({ client: suiClient });
    txDigest = await window.signAndExecuteTransaction(builtTx);
  } catch (signErr) {
    throw new Error(`[Executor] Wallet signing failed: ${signErr.message}`);
  }

  if (!txDigest) {
    throw new Error('[Executor] No txDigest returned from wallet');
  }

  /* ── If this was a manager-creation tx, extract the ID ───── */
  if (!managerKey) {
    try {
      const txInfo = await suiClient.getTransactionBlock({
        digest:  txDigest,
        options: { showObjectChanges: true },
      });
      const created = txInfo.objectChanges?.find(
        c => c.type === 'created' && c.objectType?.includes('BalanceManager')
      );
      if (created?.objectId) {
        _balanceManagerId = created.objectId;
        // sessionStorage unavailable on file:// origin — ID lives in memory for this session 
        console.log('[Executor] BalanceManager created:', _balanceManagerId);
        console.log('[Executor] Manager created. Re-submit your trade to execute the swap.');
        // Return a partial result — the next trade call will do the actual swap
        return {
          txDigest,
          amountOut: '0',
          route:     _buildRouteLabel(),
          note:      'BalanceManager initialized. Please submit your trade again.',
        };
      }
    } catch (e) {
      console.warn('[Executor] Could not extract BalanceManager ID from tx effects:', e);
    }
  }

  console.log(`[Executor] DeepBook swap settled ✓  txDigest: ${txDigest}`);

  return {
    txDigest,
    amountOut: amountOutEst.toFixed(8),
    route:     _buildRouteLabel(),
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

