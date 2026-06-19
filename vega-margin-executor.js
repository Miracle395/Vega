/* ================================================================
   VEGA — vega-margin-executor.js  v2.0
   Rebuilt against real on-chain ABI (sui_getNormalizedMoveModulesByPackage)
================================================================ */
'use strict';

const MARGIN_EXEC_CFG = {
  rpcUrl: 'https://fullnode.testnet.sui.io:443',
  tatumRpc: 'https://sui-testnet.gateway.tatum.io',
  tatumKey: 't-6a1314026dcffd29f3321133-b2b7fb9669494fdebadaf640',

  PKG:              '0xd6a42f4df4db73d68cbeb52be66698d2fe6a9464f45ad113ca52b0c6ebd918b6',
  MARGIN_REGISTRY:  '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75',

  // DeepBook core (needed by margin_manager::new)
  DEEPBOOK_PKG:      '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c',
  DEEPBOOK_REGISTRY: '0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1',
  SUI_DBUSDC_POOL:   '0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5', // DeepBook trading pool

  SUI_MARGIN_POOL:    '0xcdbbe6a72e639b647296788e2e4b1cac5cea4246028ba388ba1332ff9a382eea',
  DBUSDC_MARGIN_POOL: '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d',

  SUI_TYPE:    '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  DBUSDC_TYPE: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',

  SUI_PRICE_INFO:    '0x1ebb295c789cc42b3b2a1606482cd1c7124076a0f5676718501fda8c7fd075a0',
  DBUSDC_PRICE_INFO: '0x9c4dd4008297ffa5e480684b8100ec21cc934405ed9a25d4e4d7b6259aad9c81',

  CLOCK: '0x6',
  
  SUI_FEED_ID:    '0x50c67b3fd225db8912a424dd4baed60ffdde625ed2feaaf283724f9608fea266',
  DBUSDC_FEED_ID: '0x41f3625971ca2ed2263e78573fe5ce23e13d2558ed3f2e47ab0f84fb9e7ae722',
  PYTH_STATE_ID:      '0x243759059f4c3111179da5878c12f68d612c21a8d54d85edc86164bb18be1c7c',
  WORMHOLE_STATE_ID:  '0x31358d198147da50db32eda2562951d53973a0c0ad5ed738e9b17d88b213d790',

  SUI_SCALAR:    1_000_000_000n,
  DBUSDC_SCALAR: 1_000_000n,
};

const ZERO_ADDR = '0x' + '0'.repeat(64);

/* ── SDK LOADER ───────────────────────────────────────────────── */
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

async function _tatumRpc(method, params) {
  const res = await fetch(MARGIN_EXEC_CFG.tatumRpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': MARGIN_EXEC_CFG.tatumKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

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

async function _getDbUsdcCoins(addr) {
  const res = await _tatumRpc('suix_getCoins', [addr, MARGIN_EXEC_CFG.DBUSDC_TYPE, null, 50]);
  if (!res?.data?.length) throw new Error('No DBUSDC coins in wallet');
  return res.data;
}

let _pythModulesPromise = null;
async function _loadPythModules() {
  if (_pythModulesPromise) return _pythModulesPromise;
  _pythModulesPromise = import('https://esm.sh/@pythnetwork/pyth-sui-js');
  return _pythModulesPromise;
}

// Pushes fresh prices into the SAME tx right before they're consumed.
// Returns the (now-fresh) PriceInfoObject ids to reference downstream.
async function _freshenPythPrices(tx, suiClient) {
  const { SuiPriceServiceConnection, SuiPythClient } = await _loadPythModules();

  const connection = new SuiPriceServiceConnection('https://hermes-beta.pyth.network');
  const feedIds = [MARGIN_EXEC_CFG.SUI_FEED_ID, MARGIN_EXEC_CFG.DBUSDC_FEED_ID];
  const updateData = await connection.getPriceFeedsUpdateData(feedIds);

  const pythClient = new SuiPythClient(
    suiClient,
    MARGIN_EXEC_CFG.PYTH_STATE_ID,
    MARGIN_EXEC_CFG.WORMHOLE_STATE_ID,
  );
  const [suiPriceObj, dbusdcPriceObj] = await pythClient.updatePriceFeeds(tx, updateData, feedIds);
  return { suiPriceObj, dbusdcPriceObj };
}

/* ── find an object of a given type owned/created for addr ──────
   Used after a tx to discover newly-created shared/owned objects
   (MarginManager is shared, SupplierCap is owned) via tx effects. */
async function _findCreatedObject(digest, typeSuffix) {
  for (let i = 0; i < 5; i++) {
    const tx = await _fullnodeRpc('sui_getTransactionBlock', [digest, { showObjectChanges: true }]);
    const changes = tx?.objectChanges || [];
    const created = changes.find(c => c.type === 'created' && c.objectType?.includes(typeSuffix));
    if (created) return created.objectId;
    await new Promise(r => setTimeout(r, 1500));
  }
  return null;
}

/* ── ENSURE MARGIN MANAGER ───────────────────────────────────── */
window.ensureMarginManager = async function() {
  if (window._marginManagerId) return window._marginManagerId;

  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  // Check for an existing shared MarginManager via indexer (owned-object query won't find shared objects)
  try {
    const res = await fetch(
      `https://deepbook-indexer.testnet.mystenlabs.com/margin_managers_info`
    );
    const all = await res.json();
    const mine = all.find(m => m.deepbook_pool_id === MARGIN_EXEC_CFG.SUI_DBUSDC_POOL);
    // NOTE: indexer doesn't filter by owner — if you have multiple managers this needs
    // refinement, but for a fresh testnet wallet this is fine.
  } catch (_) {}

  console.log('[MarginExec] Creating new MarginManager...');
  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  const tx = new Transaction();
  tx.setSender(addr);

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_manager::new`,
    typeArguments: [MARGIN_EXEC_CFG.SUI_TYPE, MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(MARGIN_EXEC_CFG.SUI_DBUSDC_POOL),
      tx.object(MARGIN_EXEC_CFG.DEEPBOOK_REGISTRY),
      tx.object(MARGIN_EXEC_CFG.MARGIN_REGISTRY),
      tx.object(MARGIN_EXEC_CFG.CLOCK),
    ],
  });

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] MarginManager creation tx:', digest);

  const newId = await _findCreatedObject(digest, '::margin_manager::MarginManager<');
  if (!newId) throw new Error('MarginManager created but could not locate ID — check Suiscan for digest ' + digest);

  window._marginManagerId = newId;
  return newId;
};

/* ── DEPOSIT COLLATERAL (DBUSDC) ─────────────────────────────── */
window.executeMarginDeposit = async function({ amount }) {
  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  const managerId = await window.ensureMarginManager();
  const rawAmount = BigInt(Math.round(amount * Number(MARGIN_EXEC_CFG.DBUSDC_SCALAR)));

  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  const coins = await _getDbUsdcCoins(addr);
  const tx = new Transaction();
  tx.setSender(addr);

  const { suiPriceObj, dbusdcPriceObj } = await _freshenPythPrices(tx, suiClient); // ← NEW, before splitCoins

  const [primary, ...rest] = coins.map(c => tx.objectRef({
    objectId: c.coinObjectId, version: c.version, digest: c.digest,
  }));
  if (rest.length) tx.mergeCoins(primary, rest);
  const [depositCoin] = tx.splitCoins(primary, [tx.pure.u64(rawAmount)]);

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_manager::deposit`,
    typeArguments: [MARGIN_EXEC_CFG.SUI_TYPE, MARGIN_EXEC_CFG.DBUSDC_TYPE, MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(managerId),
      tx.object(MARGIN_EXEC_CFG.MARGIN_REGISTRY),
      suiPriceObj,      // ← was tx.object(MARGIN_EXEC_CFG.SUI_PRICE_INFO)
      dbusdcPriceObj,    // ← was tx.object(MARGIN_EXEC_CFG.DBUSDC_PRICE_INFO)
      depositCoin,
      tx.object(MARGIN_EXEC_CFG.CLOCK),
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

  const { suiPriceObj, dbusdcPriceObj } = await _freshenPythPrices(tx, suiClient); // ← NEW

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_manager::borrow_base`,
    typeArguments: [MARGIN_EXEC_CFG.SUI_TYPE, MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(managerId),
      tx.object(MARGIN_EXEC_CFG.MARGIN_REGISTRY),
      tx.object(MARGIN_EXEC_CFG.SUI_MARGIN_POOL),
      suiPriceObj,      // ← was tx.object(MARGIN_EXEC_CFG.SUI_PRICE_INFO)
      dbusdcPriceObj,    // ← was tx.object(MARGIN_EXEC_CFG.DBUSDC_PRICE_INFO)
      tx.object(MARGIN_EXEC_CFG.SUI_DBUSDC_POOL),
      tx.pure.u64(rawAmount),
      tx.object(MARGIN_EXEC_CFG.CLOCK),
    ],
  });

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] Borrow settled:', digest);
  return { txDigest: digest };
};

/* ── SUPPLY TO POOL (DBUSDC) ─────────────────────────────────── */
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
    objectId: c.coinObjectId, version: c.version, digest: c.digest,
  }));
  if (rest.length) tx.mergeCoins(primary, rest);
  const [supplyCoin] = tx.splitCoins(primary, [tx.pure.u64(rawAmount)]);

  let supplierCap;
  let mintedNewCap = false;
  if (window._supplierCapId) {
    supplierCap = tx.object(window._supplierCapId);
  } else {
    mintedNewCap = true;
    supplierCap = tx.moveCall({
      target: `${MARGIN_EXEC_CFG.PKG}::margin_pool::mint_supplier_cap`,
      arguments: [tx.object(MARGIN_EXEC_CFG.MARGIN_REGISTRY), tx.object(MARGIN_EXEC_CFG.CLOCK)],
    });
  }

  const noReferral = tx.moveCall({
    target: '0x1::option::none',
    typeArguments: ['0x2::object::ID'],
  });

  tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_pool::supply`,
    typeArguments: [MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(MARGIN_EXEC_CFG.DBUSDC_MARGIN_POOL),
      tx.object(MARGIN_EXEC_CFG.MARGIN_REGISTRY),
      supplierCap,
      supplyCoin,
      noReferral,
      tx.object(MARGIN_EXEC_CFG.CLOCK),
    ],
  });

  if (mintedNewCap) tx.transferObjects([supplierCap], addr);

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] Supply settled:', digest);

  if (mintedNewCap) {
    const capId = await _findCreatedObject(digest, '::margin_pool::SupplierCap');
    if (capId) window._supplierCapId = capId;
  }

  return { txDigest: digest };
};

/* ── WITHDRAW FROM POOL ──────────────────────────────────────── */
window.executeMarginWithdraw = async function({ amount }) {
  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');
  if (!window._supplierCapId) throw new Error('No supply position found');

  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });

  const tx = new Transaction();
  tx.setSender(addr);

  const amountArg = amount
    ? tx.moveCall({
        target: '0x1::option::some',
        typeArguments: ['u64'],
        arguments: [tx.pure.u64(BigInt(Math.round(amount * Number(MARGIN_EXEC_CFG.DBUSDC_SCALAR))))],
      })
    : tx.moveCall({ target: '0x1::option::none', typeArguments: ['u64'] });

  const [withdrawnCoin] = tx.moveCall({
    target: `${MARGIN_EXEC_CFG.PKG}::margin_pool::withdraw`,
    typeArguments: [MARGIN_EXEC_CFG.DBUSDC_TYPE],
    arguments: [
      tx.object(MARGIN_EXEC_CFG.DBUSDC_MARGIN_POOL),
      tx.object(MARGIN_EXEC_CFG.MARGIN_REGISTRY),
      tx.object(window._supplierCapId),
      amountArg,
      tx.object(MARGIN_EXEC_CFG.CLOCK),
    ],
  });

  tx.transferObjects([withdrawnCoin], addr);

  await tx.build({ client: suiClient });
  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[MarginExec] Withdraw settled:', digest);
  return { txDigest: digest };
};

/* ── READS: pool totals via devInspect (no signing needed) ──── */
async function _devInspectU64(target, typeArgs, objectId) {
  const { Transaction, SuiClient } = await _loadMarginModules();
  const suiClient = new SuiClient({ url: MARGIN_EXEC_CFG.rpcUrl });
  const tx = new Transaction();
  tx.setSender(ZERO_ADDR);
  tx.moveCall({ target, typeArguments: typeArgs, arguments: [tx.object(objectId)] });

  const result = await suiClient.devInspectTransactionBlock({ sender: ZERO_ADDR, transactionBlock: tx });
  const bytes = result?.results?.[0]?.returnValues?.[0]?.[0];
  if (!bytes) return null;
  let val = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) val = (val << 8n) | BigInt(bytes[i]);
  return val;
}

window.fetchMarginPoolMetrics = async function() {
  try {
    const [suiSupply, suiBorrow, dbSupply, dbBorrow] = await Promise.all([
      _devInspectU64(`${MARGIN_EXEC_CFG.PKG}::margin_pool::total_supply`, [MARGIN_EXEC_CFG.SUI_TYPE], MARGIN_EXEC_CFG.SUI_MARGIN_POOL),
      _devInspectU64(`${MARGIN_EXEC_CFG.PKG}::margin_pool::total_borrow`, [MARGIN_EXEC_CFG.SUI_TYPE], MARGIN_EXEC_CFG.SUI_MARGIN_POOL),
      _devInspectU64(`${MARGIN_EXEC_CFG.PKG}::margin_pool::total_supply`, [MARGIN_EXEC_CFG.DBUSDC_TYPE], MARGIN_EXEC_CFG.DBUSDC_MARGIN_POOL),
      _devInspectU64(`${MARGIN_EXEC_CFG.PKG}::margin_pool::total_borrow`, [MARGIN_EXEC_CFG.DBUSDC_TYPE], MARGIN_EXEC_CFG.DBUSDC_MARGIN_POOL),
    ]);
    return {
      sui:    { totalSupply: Number(suiSupply || 0n), totalBorrows: Number(suiBorrow || 0n) },
      dbusdc: { totalSupply: Number(dbSupply  || 0n), totalBorrows: Number(dbBorrow  || 0n) },
    };
  } catch (err) {
    console.warn('[MarginExec] Pool metrics fetch failed:', err.message);
    return null;
  }
};

/* ── READS: risk ratio via indexer (avoids rebuilding Pyth-heavy PTB) */
window.fetchMarginRiskRatio = async function(managerId) {
  if (!managerId) return null;
  try {
    const url = `https://deepbook-indexer.testnet.mystenlabs.com/margin_manager_states?deepbook_pool_id=${MARGIN_EXEC_CFG.SUI_DBUSDC_POOL}`;
    const res = await fetch(url);
    const all = await res.json();
    const mine = all.find(m => m.margin_manager_id === managerId);
    if (!mine) return null;

    const baseAsset = Number(mine.base_asset) / Number(MARGIN_EXEC_CFG.SUI_SCALAR);
    const baseDebt  = Number(mine.base_debt)  / Number(MARGIN_EXEC_CFG.SUI_SCALAR);
    return { ratio: Number(mine.risk_ratio), baseAsset, baseDebt };
  } catch (err) {
    console.warn('[MarginExec] Risk ratio fetch failed:', err.message);
    return null;
  }
};

console.log('[MarginExec] vega-margin-executor.js v2.0 loaded');
