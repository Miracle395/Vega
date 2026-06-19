/* ================================================================
   VEGA — vega-margin-executor.js  v1.0
   DeepBook Margin execution layer.

   Mirrors vega-executor.js exactly:
   - Imports Transaction + SuiClient from esm.sh (proven to work)
   - Builds PTBs, calls tx.build({ client }) to resolve intents
   - Delegates signing to window.signAndExecuteTransaction

   Load order in vegamargin.html:
     vega-wallet.js → vega-margin-executor.js → vegamargin.js
================================================================ */
'use strict';

/* ── CONFIG ──────────────────────────────────────────────────── */
const MARGIN_EXEC_CFG = {
  rpcUrl: 'https://fullnode.testnet.sui.io:443',
  tatumRpc: 'https://sui-testnet.gateway.tatum.io',
  tatumKey: 't-6a1314026dcffd29f3321133-b2b7fb9669494fdebadaf640',

  PKG:         '0xd6a42f4df4db73d68cbeb52be66698d2fe6a9464f45ad113ca52b0c6ebd918b6',
  REGISTRY:    '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75',
  SUI_POOL:    '0xcdbbe6a72e639b647296788e2e4b1cac5cea4246028ba388ba1332ff9a382eea',
  DBUSDC_POOL: '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d',

  SUI_TYPE:    '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  DBUSDC_TYPE: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',

  SUI_SCALAR:    1_000_000_000n,
  DBUSDC_SCALAR: 1_000_000n,
};

/* ── SDK LOADER (same pattern as vega-executor.js) ───────────── */
let _marginModulesPromise = null;

async function _loadMarginModules() {
  if (_marginModulesPromise) return _marginModulesPromise;

  _marginModulesPromise = (async () => {
    const { SuiClient }   = await import('https://esm.sh/@mysten/sui@1.21.1/client');
    const { Transaction } = await import('https://esm.sh/@mysten/sui@1.21.1/transactions');
    console.log('[MarginExec] SDK modules loaded');
    return { SuiClient, Transaction };
  })();

  return _marginModulesPromise;
}

/* ── MINIMAL TATUM RPC (for getCoins — Tatum supports this) ─── */
async function _tatumRpc(method, params) {
  const res = await fetch(MARGIN_EXEC_CFG.tatumRpc, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': MARGIN_EXEC_CFG.tatumKey,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

/* ── FULL RPC (fullnode — for sui_getObject, suix_getOwnedObjects) */
async function _fullnodeRpc(method, params) {
  const res = await fetch(MARGIN_EXEC_CFG.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

/* ── GET DBUSDC COIN OBJECTS ─────────────────────────────────── */
async function _getDbUsdcCoins(addr) {
  const res = await _tatumRpc('suix_getCoins', [addr, MARGIN_EXEC_CFG.DBUSDC_TYPE, null, 50]);
  if (!res?.data?.length) throw new Error('No DBUSDC coins in wallet');
  return res.data;
}

/* ── ENSURE MARGIN MANAGER ───────────────────────────────────── */
// Returns existing manager ID or creates one on-chain.
window.ensureMarginManager = async function() {
  // Return cached
  if (window._marginManagerId) return window._marginManagerId;

  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  // Check on-chain for existing manager
  try {
    const owned = await _fullnodeRpc('suix_getOwnedObjects', [
      addr,
      {
        filter: { StructType: `${MARGIN_EXEC_CFG.PKG}::margin_manager::MarginManager` },
        options: { showContent: false },
      },
      null,
      5,
    ]);
    const existing = owned?.data?.[0]?.data?.objectId;
    if (existing) {
      console.log('[MarginExec] Found existing MarginManager:', existing);
      window._marginManagerId = existing;
      return existing;
    }
  } catch (_) {}

  // Create new manager
  console.log('[MarginExec] Creating new MarginManager...');
  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  const tx = new Transaction();
  tx.setSender(addr);

  const [manager] = tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_manager::new`,
    arguments: [],
  });

  tx.transferObjects([manager], addr);
  await tx.build({ client: suiClient });

  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] MarginManager created, digest:', digest);

  // Wait for finality then fetch the new object
  await new Promise(r => setTimeout(r, 2500));
  const owned2 = await _fullnodeRpc('suix_getOwnedObjects', [
    addr,
    {
      filter: { StructType: `${MARGIN_EXEC_CFG.PKG}::margin_manager::MarginManager` },
      options: { showContent: false },
    },
    null, 5,
  ]);
  const newId = owned2?.data?.[0]?.data?.objectId;
  if (!newId) throw new Error('MarginManager created but could not fetch ID — try refreshing');

  window._marginManagerId = newId;
  return newId;
};

/* ── DEPOSIT COLLATERAL ──────────────────────────────────────── */
window.executeMarginDeposit = async function({ amount }) {
  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  const managerId = await window.ensureMarginManager();
  const rawAmount = BigInt(Math.round(amount * Number(MARGIN_EXEC_CFG.DBUSDC_SCALAR)));

  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  // Merge + split DBUSDC coins
  const coins = await _getDbUsdcCoins(addr);
  const tx = new Transaction();
  tx.setSender(addr);

  const [primary, ...rest] = coins.map(c => tx.objectRef({
    objectId: c.coinObjectId,
    version:  c.version,
    digest:   c.digest,
  }));
  if (rest.length) tx.mergeCoins(primary, rest);
  const [depositCoin] = tx.splitCoins(primary, [tx.pure.u64(rawAmount)]);

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_manager::deposit`,
    typeArguments: [MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(managerId),
      depositCoin,
    ],
  });

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] Deposit settled:', digest);
  return { txDigest: digest };
};

/* ── BORROW SUI ──────────────────────────────────────────────── */
window.executeMarginBorrow = async function({ amount }) {
  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  const managerId = await window.ensureMarginManager();
  const rawAmount = BigInt(Math.round(amount * Number(MARGIN_EXEC_CFG.SUI_SCALAR)));

  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  const tx = new Transaction();
  tx.setSender(addr);

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_manager::borrow_base`,
    typeArguments: [MARGIN_EXEC_CFG.SUI_TYPE, MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(managerId),
      tx.object(MARGIN_EXEC_CFG.SUI_POOL),
      tx.pure.u64(rawAmount),
    ],
  });

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] Borrow settled:', digest);
  return { txDigest: digest };
};

/* ── SUPPLY TO POOL ──────────────────────────────────────────── */
window.executeMarginSupply = async function({ amount }) {
  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  const rawAmount = BigInt(Math.round(amount * Number(MARGIN_EXEC_CFG.DBUSDC_SCALAR)));

  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  const coins = await _getDbUsdcCoins(addr);
  const tx = new Transaction();
  tx.setSender(addr);

  const [primary, ...rest] = coins.map(c => tx.objectRef({
    objectId: c.coinObjectId,
    version:  c.version,
    digest:   c.digest,
  }));
  if (rest.length) tx.mergeCoins(primary, rest);
  const [supplyCoin] = tx.splitCoins(primary, [tx.pure.u64(rawAmount)]);

  // Mint supplier cap if we don't have one cached
  let supplierCap;
  if (!window._supplierCapId) {
    supplierCap = tx.moveCall({
      target: `${MARGIN_EXEC_CFG.PKG}::margin_pool::mint_supplier_cap`,
      typeArguments: [MARGIN_EXEC_CFG.DBUSDC_TYPE],
      arguments: [tx.object(MARGIN_EXEC_CFG.DBUSDC_POOL)],
    });
  } else {
    supplierCap = tx.object(window._supplierCapId);
  }

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_pool::supply_to_margin_pool`,
    typeArguments: [MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(MARGIN_EXEC_CFG.DBUSDC_POOL),
      supplierCap,
      supplyCoin,
    ],
  });

  // Transfer newly minted cap to user
  if (!window._supplierCapId) {
    tx.transferObjects([supplierCap], addr);
  }

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] Supply settled:', digest);
  return { txDigest: digest };
};

/* ── WITHDRAW FROM POOL ──────────────────────────────────────── */
window.executeMarginWithdraw = async function({ amount }) {
  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  if (!window._supplierCapId) throw new Error('No supply position found');

  const rawAmount = BigInt(Math.round(amount * Number(MARGIN_EXEC_CFG.DBUSDC_SCALAR)));

  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  const tx = new Transaction();
  tx.setSender(addr);

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_pool::withdraw_from_margin_pool`,
    typeArguments: [MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(MARGIN_EXEC_CFG.DBUSDC_POOL),
      tx.object(window._supplierCapId),
      tx.pure.u64(rawAmount),
    ],
  });

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] Withdraw settled:', digest);
  return { txDigest: digest };
};

/* ── POOL METRICS (on-chain object read) ─────────────────────── */
window.fetchMarginPoolMetrics = async function() {
  try {
    const [suiObj, dbObj] = await Promise.all([
      _fullnodeRpc('sui_getObject', [MARGIN_EXEC_CFG.SUI_POOL,    { showContent: true }]),
      _fullnodeRpc('sui_getObject', [MARGIN_EXEC_CFG.DBUSDC_POOL, { showContent: true }]),
    ]);

    const suiFields = suiObj?.data?.content?.fields?.state?.fields || {};
    const dbFields  = dbObj?.data?.content?.fields?.state?.fields  || {};

    return {
      sui: {
        totalSupply:  Number(suiFields.total_supply  || suiFields.supply_amount  || 0),
        totalBorrows: Number(suiFields.total_borrows || suiFields.borrow_amount  || 0),
      },
      dbusdc: {
        totalSupply:  Number(dbFields.total_supply  || dbFields.supply_amount  || 0),
        totalBorrows: Number(dbFields.total_borrows || dbFields.borrow_amount  || 0),
      },
    };
  } catch (err) {
    console.warn('[MarginExec] Pool metrics fetch failed:', err.message);
    return null;
  }
};

/* ── RISK RATIO (on-chain manager read) ──────────────────────── */
window.fetchMarginRiskRatio = async function(managerId) {
  if (!managerId) return null;
  try {
    const obj = await _fullnodeRpc('sui_getObject', [managerId, { showContent: true }]);
    const fields = obj?.data?.content?.fields || {};
    const baseAsset = Number(fields.base_asset || 0) / Number(MARGIN_EXEC_CFG.SUI_SCALAR);
    const baseDebt  = Number(fields.base_debt  || 0) / Number(MARGIN_EXEC_CFG.SUI_SCALAR);
    const ratio     = baseDebt > 0 ? baseAsset / baseDebt : 0;
    return { ratio, baseAsset, baseDebt };
  } catch (err) {
    console.warn('[MarginExec] Risk ratio fetch failed:', err.message);
    return null;
  }
};

console.log('[MarginExec] vega-margin-executor.js loaded');
