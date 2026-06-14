/* ================================================================
   GAMBIT DEX — vega-executor.js  v3.0
   Spot trade execution via DeepBook V3.

   Strategy: Use ONLY @mysten/deepbook-v3 from esm.sh (which works).
   For SuiClient, use a minimal hand-rolled JSON-RPC client so we
   never need to import @mysten/sui from any CDN.

   Load order in index.html:
     walrus.js → vega-wallet.js → vega-executor.js → vega.js
================================================================ */
'use strict';

/* ── NETWORK CONFIG ──────────────────────────────────────────── */
const EXECUTOR_CONFIG = {
  network: 'TESTNET',

  TESTNET: {
    tatumRpc: 'https://sui-testnet.gateway.tatum.io',
    tatumKey: 't-6a1314026dcffd29f3321133-b2b7fb9669494fdebadaf640',
    rpcUrl:   'https://fullnode.testnet.sui.io:443',
    USDC: '0x65b0553a591d7b13376e03a408e112c706dc0909a79080c810b93b06f922c458::usdc::USDC',
    SUI:  '0x2::sui::SUI',
  },

  MAINNET: {
    tatumRpc: 'https://sui-mainnet.gateway.tatum.io',
    tatumKey: 't-6a1314026dcffd29f3321133-cb8c2fb42a924934a367b95b',
    rpcUrl:   'https://fullnode.mainnet.sui.io:443',
    USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    SUI:  '0x2::sui::SUI',
  },
};

function _execCfg() {
  return EXECUTOR_CONFIG[EXECUTOR_CONFIG.network];
}

/* ── MINIMAL SUI JSON-RPC CLIENT ─────────────────────────────── */
// Replaces @mysten/sui SuiClient — no CDN needed.
// DeepBookClient only uses: getCoins, getReferenceGasPrice, dryRunTransactionBlock
// Transaction.build() only needs: getReferenceGasPrice + getCoins for gas
function _makeSuiRpcClient(rpcUrl) {
  async function call(method, params = []) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const data = await res.json();
    if (data.error) throw new Error(`RPC ${method} error: ${data.error.message}`);
    return data.result;
  }

  return {
    // Used by DeepBookClient internals
    async getCoins({ owner, coinType }) {
      return call('suix_getCoins', [owner, coinType, null, 50]);
    },
    async getReferenceGasPrice() {
      return call('suix_getReferenceGasPrice', []);
    },
    async getNormalizedMoveFunction({ package: pkg, module, function: fn }) {
      return call('sui_getNormalizedMoveFunction', [pkg, module, fn]);
    },
    async getObject({ id, options }) {
      return call('sui_getObject', [id, options || { showContent: true }]);
    },
    async multiGetObjects({ ids, options }) {
      return call('sui_multiGetObjects', [ids, options || { showContent: true }]);
    },
    async dryRunTransactionBlock({ transactionBlock }) {
      const b64 = typeof transactionBlock === 'string'
        ? transactionBlock
        : btoa(String.fromCharCode(...transactionBlock));
      return call('sui_dryRunTransactionBlock', [b64]);
    },
    async executeTransactionBlock({ transactionBlock, signature, options }) {
      const b64 = typeof transactionBlock === 'string'
        ? transactionBlock
        : btoa(String.fromCharCode(...transactionBlock));
      return call('sui_executeTransactionBlock', [b64, [signature], options || {}]);
    },
    // Required by Transaction.build()
    async getGasPrice() {
      const price = await call('suix_getReferenceGasPrice', []);
      return BigInt(price);
    },
  };
}

/* ── DEEPBOOK SDK LOADER ──────────────────────────────────────── */
let _dbModulesPromise = null;

async function _loadDeepBookModules() {
  if (_dbModulesPromise) return _dbModulesPromise;

  _dbModulesPromise = (async () => {
    // Only import deepbook-v3 — it bundles its own Transaction class
    const dbMod = await import('https://esm.sh/@mysten/deepbook-v3');
    const DeepBookClient = dbMod.DeepBookClient;

    // Transaction comes bundled inside deepbook-v3's esm.sh build
    // Get it from there rather than a separate import
const { SuiClient } = await import('https://esm.sh/@mysten/sui@1.21.1/client');
const { Transaction } = await import('https://esm.sh/@mysten/sui@1.21.1/transactions');

    console.log('[Executor] DeepBook SDK modules loaded');
    return { DeepBookClient, Transaction, SuiClient, dbMod };
  })();

  return _dbModulesPromise;
}

/* ── BALANCE MANAGER CACHE ───────────────────────────────────── */
let _balanceManagerId = (() => { try { return localStorage.getItem('vega_bm_id'); } catch(_) { return null; } })();

/* ── MAIN TRADE EXECUTOR ─────────────────────────────────────── */
window.executeSpotTrade = async function({ from, to, amountIn, slippage = 0.5 }) {
  const wallet     = window.STATE?.suiWallet;
  const walletAddr = window.STATE?.walletAddr;

  if (!wallet || !walletAddr) throw new Error('Wallet not connected');

  console.log(`[Executor] Starting DeepBook swap: ${amountIn} ${from} → ${to}`);

  const { poolKey, isBaseIn } = _resolvePoolAndSide(from, to);

  /* ── Load SDK ─────────────────────────────────────────────── */
  let DeepBookClient, Transaction, dbMod, SuiClient;
  try {
   ({ DeepBookClient, Transaction, dbMod, SuiClient } = await Promise.race([
      _loadDeepBookModules(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('SDK load timed out after 30s')), 30000)
      ),
    ]));
  } catch (e) {
    throw new Error(`Routing unavailable — ${e.message}`);
  }

  const cfg      = _execCfg();
  const network  = EXECUTOR_CONFIG.network === 'TESTNET' ? 'testnet' : 'mainnet';
  const suiClient = new SuiClient({ url: cfg.rpcUrl });

  const packageIds = network === 'testnet' ? dbMod.testnetPackageIds : dbMod.mainnetPackageIds;
  const pools      = network === 'testnet' ? dbMod.testnetPools      : dbMod.mainnetPools;
  const coins      = network === 'testnet' ? dbMod.testnetCoins      : dbMod.mainnetCoins;

  const dbClient = new DeepBookClient({
    address: walletAddr,
    client:  suiClient,
    packageIds,
    pools,
    coins,
  });

  const tx = new Transaction();
  tx.setSender(walletAddr);
  
  // Provide client so CoinWithBalance intents resolve correctly

  /* ── Mid-price + minOut ───────────────────────────────────── */
  const midPrice = window.STATE?.midPrice || 0;
  if (!midPrice) throw new Error('[Executor] No live price — wait for order book');
  const amountOutEst = isBaseIn ? amountIn * midPrice : amountIn / midPrice;
  const minOut       = 0;

 // Build the input coin via CoinWithBalance — splits exactly the amount
  // needed off your existing SUI/DBUSDC, leaving the remainder free for gas.
  let inputCoin;
if (isBaseIn) {
  const amountMist = BigInt(Math.round(amountIn * 1e9));
  const [splitCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
  inputCoin = splitCoin;
} else {
  const dbusdcInfo = dbMod.testnetCoins?.DBUSDC || coins?.DBUSDC;
  if (!dbusdcInfo?.type) throw new Error('[Executor] DBUSDC coin type not found in SDK constants');
  const scalar = dbusdcInfo.scalar || 1_000_000;
  const amountRaw = BigInt(Math.round(amountIn * scalar));
  // Get all DBUSDC coins owned by wallet and merge+split
  const coinObjs = await suiClient.getCoins({ owner: walletAddr, coinType: dbusdcInfo.type });
  if (!coinObjs?.data?.length) throw new Error('[Executor] No DBUSDC coins in wallet');
  const [primary, ...rest] = coinObjs.data.map(c => tx.objectRef({
    objectId: c.coinObjectId, version: c.version, digest: c.digest
  }));
  if (rest.length) tx.mergeCoins(primary, rest);
  const [splitCoin] = tx.splitCoins(primary, [tx.pure.u64(amountRaw)]);
  inputCoin = splitCoin;
}

  // Manually supply a zero-value DEEP coin so the SDK doesn't need to
  // resolve a CoinWithBalance(DEEP, 0) intent — works even if the wallet
  // has never held any DEEP (testnet DEEP is currently unobtainable).
  const deepType = dbMod.testnetCoins?.DEEP?.type || coins?.DEEP?.type;
  const [zeroDeep] = tx.moveCall({ target: '0x2::coin::zero', typeArguments: [deepType] });

  const _qty = isBaseIn
    ? BigInt(Math.round(amountIn * 1_000_000_000))
    : BigInt(Math.round(amountIn * 1_000_000));

  const [baseOut, quoteOut, deepOut] = dbClient.deepBook.swapExactQuantity({
    poolKey,
    isBaseToQuote: isBaseIn,
    amount:       _qty,
    deepAmount:   0n,
    minOut,
    baseCoin:  isBaseIn  ? inputCoin : undefined,
    quoteCoin: !isBaseIn ? inputCoin : undefined,
    deepCoin:  zeroDeep,
  })(tx);

  // swap_exact_quantity returns base/quote/deep coins that must be consumed —
  // send them all back to the wallet.
  tx.transferObjects([baseOut, quoteOut, deepOut], walletAddr);

  // Resolve the remaining CoinWithBalance intent (quote-out, balance 0)
  // using our suiClient BEFORE handing tx to the wallet for signing.
  
 await tx.build({ client: suiClient });

  /* ── Sign + broadcast ─────────────────────────────────────── */
  let txDigest;
  try {
    txDigest = await window.signAndExecuteTransaction(tx);
  } catch (e) {
    throw new Error(`[Executor] Wallet signing failed: ${e.message}`);
  }

  if (!txDigest) throw new Error('[Executor] No txDigest returned from wallet');

  console.log(`[Executor] DeepBook swap settled ✓  txDigest: ${txDigest}`);
  return {
    txDigest,
    amountOut: amountOutEst.toFixed(8),
    route:     _buildRouteLabel(),
  };
};

/* ── HELPERS ─────────────────────────────────────────────────── */
function _resolvePoolAndSide(from, to) {
  const F = from.toUpperCase(), T = to.toUpperCase();
  const isUSDC = s => s === 'USDC' || s === 'DBUSDC';
  if (F === 'SUI'    && isUSDC(T)) return { poolKey: 'SUI_DBUSDC', isBaseIn: true  };
  if (isUSDC(F)      && T === 'SUI') return { poolKey: 'SUI_DBUSDC', isBaseIn: false };
  throw new Error(`[Executor] No pool configured for ${from} → ${to}`);
}

function _buildRouteLabel() { return 'DeepBook CLOB'; }

window.executorSetNetwork = function(n) {
  const key = n.toUpperCase();
  if (key !== 'MAINNET' && key !== 'TESTNET') throw new Error('Must be mainnet or testnet');
  EXECUTOR_CONFIG.network = key;
  _dbModulesPromise = null;
  console.log(`[Executor] Network → ${key}`);
};

window.fetchOrderbook = async function() { return null; };
