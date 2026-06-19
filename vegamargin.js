'use strict';

/* ================================================================
   VEGA MARGIN — vegamargin.js
   DeepBook Margin SDK integration (testnet)
   Deposit, Borrow, Supply, Withdraw + pool metrics
================================================================ */

/* ── CONSTANTS ─────────────────────────────────────────────────── */

const MARGIN = {
  INDEXER:     'https://deepbook-indexer.testnet.mystenlabs.com',
  RPC:         'https://sui-testnet.gateway.tatum.io',
  RPC_KEY:     't-6a1314026dcffd29f3321133-b2b7fb9669494fdebadaf640',

  PKG:         '0xd6a42f4df4db73d68cbeb52be66698d2fe6a9464f45ad113ca52b0c6ebd918b6',
  REGISTRY:    '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75',

  SUI_POOL:    '0xcdbbe6a72e639b647296788e2e4b1cac5cea4246028ba388ba1332ff9a382eea',
  DBUSDC_POOL: '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d',

  SUI_TYPE:    '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  DBUSDC_TYPE: '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',

  SUI_SCALAR:    1_000_000_000,
  DBUSDC_SCALAR: 1_000_000,
};

/* ── STATE ──────────────────────────────────────────────────────── */

const MG = {
  marginManagerId: null,   // created on first deposit
  supplierCapId:   null,   // created on first supply
  poolMetrics:     {},
  userBalances:    {},
};

/* ── UTILS ──────────────────────────────────────────────────────── */

const $id = id => document.getElementById(id);

function fmtAmt(raw, scalar, decimals = 2) {
  if (raw == null || raw === '') return '—';
  const n = Number(raw) / scalar;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(2) + 'K';
  return n.toFixed(decimals);
}

function fmtPct(raw, decimals = 2) {
  if (raw == null) return '—';
  return (Number(raw) * 100).toFixed(decimals) + '%';
}

function setEl(id, val) {
  const el = $id(id);
  if (el) el.textContent = val;
}

function setBtnState(id, loading) {
  const btn = $id(id);
  if (!btn) return;
  btn.disabled = loading;
  btn.style.opacity = loading ? '0.6' : '1';
}

/* ── RPC CALL ───────────────────────────────────────────────────── */

async function suiRpc(method, params) {
  const res = await fetch(MARGIN.RPC, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': MARGIN.RPC_KEY,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

/* ── POOL METRICS (on-chain) ────────────────────────────────────── */

// Piecewise linear interest rate model
// Utilization 0→80%: Base + (util/kink) * (Slope1 - Base)
// Utilization 80→100%: Slope1 + ((util-kink)/(1-kink)) * (Slope2 - Slope1)
function computeAPR(totalSupply, totalBorrow, scalar) {
  if (totalSupply === 0) return { borrowAPR: 0.02, supplyAPR: 0 };
  const util  = totalBorrow / totalSupply;
  const BASE  = 0.02;   // 2%  floor
  const KINK  = 0.80;   // 80% kink
  const S1    = 0.20;   // 20% at kink
  const S2    = 1.50;   // 150% at 100% util
  const SPREAD = 0.10;  // 10% protocol cut

  let borrowAPR;
  if (util <= KINK) {
    borrowAPR = BASE + (util / KINK) * (S1 - BASE);
  } else {
    borrowAPR = S1 + ((util - KINK) / (1 - KINK)) * (S2 - S1);
  }

  // Supply APR = borrow APR * utilization * (1 - protocol spread)
  const supplyAPR = borrowAPR * util * (1 - SPREAD);
  return { borrowAPR, supplyAPR, util };
}

async function fetchPoolMetrics() {
  try {
    const [suiObj, dbObj] = await Promise.all([
      suiRpc('suix_getObject', [MARGIN.SUI_POOL,    { showContent: true }]),
      suiRpc('suix_getObject', [MARGIN.DBUSDC_POOL, { showContent: true }]),
    ]);

    const suiFields = suiObj?.data?.content?.fields?.state?.fields   || {};
    const dbFields  = dbObj?.data?.content?.fields?.state?.fields    || {};

    MG.poolMetrics.sui = {
      totalSupply:  Number(suiFields.total_supply  || suiFields.supply_amount  || 0),
      totalBorrows: Number(suiFields.total_borrows || suiFields.borrow_amount  || 0),
    };
    MG.poolMetrics.dbusdc = {
      totalSupply:  Number(dbFields.total_supply   || dbFields.supply_amount   || 0),
      totalBorrows: Number(dbFields.total_borrows  || dbFields.borrow_amount   || 0),
    };

    renderPoolMetrics();
  } catch (err) {
    console.warn('[Margin] Pool object fetch failed:', err.message);
  }
}

function renderPoolMetrics() {
  const sui = MG.poolMetrics.sui;
  const db  = MG.poolMetrics.dbusdc;

  if (sui) {
    const { borrowAPR, supplyAPR, util } = computeAPR(
      sui.totalSupply, sui.totalBorrows, MARGIN.SUI_SCALAR
    );
    const liq = sui.totalSupply - sui.totalBorrows;
    const pct = Math.min((util || 0) * 100, 100);

    setEl('sui-liquidity',    fmtAmt(liq, MARGIN.SUI_SCALAR) + ' SUI');
    setEl('sui-borrow-apr',   fmtPct(borrowAPR));
    setEl('sui-borrow-apr-2', fmtPct(borrowAPR));
    setEl('sui-deposit-apr',  fmtPct(supplyAPR));

    const fill = $id('mg-health-fill');
    if (fill) fill.style.width = pct + '%';
    setEl('mg-util-pct',      pct.toFixed(1) + '%');
    setEl('mg-utilization',   pct.toFixed(1) + '%');
    setEl('mg-active-loans',  fmtAmt(sui.totalBorrows, MARGIN.SUI_SCALAR) + ' SUI');
  }

  if (db) {
    const { borrowAPR, supplyAPR } = computeAPR(
      db.totalSupply, db.totalBorrows, MARGIN.DBUSDC_SCALAR
    );
    setEl('dbusdc-total-supply', fmtAmt(db.totalSupply, MARGIN.DBUSDC_SCALAR) + ' DBUSDC');
    setEl('dbusdc-supply-apr',   fmtPct(supplyAPR));
    setEl('dbusdc-apy',          fmtPct(supplyAPR));
    setEl('dbusdc-earn-rate',    fmtPct(supplyAPR));
    setEl('mg-total-deposits',   fmtAmt(db.totalSupply, MARGIN.DBUSDC_SCALAR) + ' DBUSDC');
  }
}


/* ── USER BALANCES ──────────────────────────────────────────────── */

async function fetchUserBalances(addr) {
  try {
    const res = await suiRpc('suix_getAllBalances', [addr]);
    const bals = res || [];

    const sui = bals.find(b =>
      b.coinType === MARGIN.SUI_TYPE ||
      b.coinType?.includes('::sui::SUI')
    );
    const dbusdc = bals.find(b =>
      b.coinType === MARGIN.DBUSDC_TYPE ||
      b.coinType?.toLowerCase().includes('dbusdc')
    );

    const suiBal   = sui    ? Number(sui.totalBalance)    / MARGIN.SUI_SCALAR    : 0;
    const dbusdcBal = dbusdc ? Number(dbusdc.totalBalance) / MARGIN.DBUSDC_SCALAR : 0;

    MG.userBalances.sui    = suiBal;
    MG.userBalances.dbusdc = dbusdcBal;

    setEl('sui-deposit-balance', dbusdcBal.toFixed(2));
    setEl('sui-supply-balance',  dbusdcBal.toFixed(2));
    setEl('dbusdc-wallet-bal',   dbusdcBal.toFixed(2) + ' DBUSDC');
  } catch (err) {
    console.warn('[Margin] Balance fetch failed:', err.message);
  }
}

/* ── MARGIN MANAGER ─────────────────────────────────────────────── */

async function ensureMarginManager() {
  if (MG.marginManagerId) return MG.marginManagerId;

  const addr = window.STATE?.walletAddr;
  if (!addr) throw new Error('Wallet not connected');

  // Check if user already has a margin manager via owned objects
  try {
    const owned = await suiRpc('suix_getOwnedObjects', [
      addr,
      {
        filter: { StructType: `${MARGIN.PKG}::margin_manager::MarginManager` },
        options: { showContent: false },
      },
      null,
      5,
    ]);
    const existing = owned?.data?.[0]?.data?.objectId;
    if (existing) {
      MG.marginManagerId = existing;
      console.log('[Margin] Found existing MarginManager:', existing);
      return existing;
    }
  } catch (_) {}

  // Create new margin manager
  console.log('[Margin] Creating new MarginManager...');
  const { Transaction } = await import('https://cdn.jsdelivr.net/npm/@mysten/sui@latest/+esm');
  const tx = new Transaction();

  tx.moveCall({
    target: `${MARGIN.PKG}::margin_manager::new`,
    arguments: [],
  });

  const digest = await window.signAndExecuteTransaction(tx);
  console.log('[Margin] MarginManager created, digest:', digest);

  // Fetch the newly created manager ID
  await new Promise(r => setTimeout(r, 2000));
  const res2 = await fetch(`${MARGIN.INDEXER}/margin_managers_info?owner=${addr}`);
  const data2 = await res2.json();
  if (Array.isArray(data2) && data2.length > 0) {
    MG.marginManagerId = data2[0].margin_manager_id;
  }

  return MG.marginManagerId;
}

/* ── TOAST ──────────────────────────────────────────────────────── */

function toast(msg, type = 'info') {
  const existing = document.getElementById('mg-toast');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'mg-toast';
  el.textContent = msg;
  el.style.cssText = [
    'position:fixed',
    'bottom:24px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:9999',
    'padding:10px 20px',
    'border-radius:10px',
    'font-size:13px',
    'font-weight:600',
    'font-family:Geist,sans-serif',
    'pointer-events:none',
    type === 'success'
      ? 'background:#67ffca;color:#000;'
      : type === 'error'
      ? 'background:#ff4757;color:#fff;'
      : 'background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.12);',
  ].join(';');

  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ── GET COIN OBJECT ────────────────────────────────────────────── */

async function getCoinObject(addr, coinType, minAmount) {
  const coins = await suiRpc('suix_getCoins', [addr, coinType, null, 10]);
  const all = coins?.data || [];
  const enough = all.find(c => Number(c.balance) >= minAmount);
  if (!enough) throw new Error(`Insufficient ${coinType.split('::').pop()} balance`);
  return enough.coinObjectId;
}

/* ── DEPOSIT (collateral into MarginManager) ────────────────────── */

window.marginDeposit = async function(market) {
  const addr = window.STATE?.walletAddr;
  if (!addr) { toast('Connect wallet first', 'error'); return; }

  const input = $id('sui-deposit-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount <= 0) { toast('Enter an amount', 'error'); return; }

  const rawAmount = Math.floor(amount * MARGIN.DBUSDC_SCALAR);

  setBtnState('sui-deposit-btn', true);
  toast('Preparing deposit...');

  try {
    const managerId = await ensureMarginManager();
    const coinId    = await getCoinObject(addr, MARGIN.DBUSDC_TYPE, rawAmount);

    const { Transaction } = await import('https://cdn.jsdelivr.net/npm/@mysten/sui@latest/+esm');
    const tx = new Transaction();

    // Split exact amount from coin
    const [depositCoin] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(rawAmount)]);

    tx.moveCall({
      target: `${MARGIN.PKG}::margin_manager::deposit`,
      typeArguments: [MARGIN.DBUSDC_TYPE],
      arguments: [
        tx.object(managerId),
        depositCoin,
      ],
    });

    const digest = await window.signAndExecuteTransaction(tx);
    toast(`Deposited ${amount} DBUSDC ✓`, 'success');
    console.log('[Margin] Deposit digest:', digest);

    if (input) input.value = '';
    setTimeout(() => fetchUserBalances(addr), 2000);

  } catch (err) {
    console.error('[Margin] Deposit error:', err);
    toast(err.message?.slice(0, 60) || 'Deposit failed', 'error');
  } finally {
    setBtnState('sui-deposit-btn', false);
  }
};

/* ── BORROW SUI ─────────────────────────────────────────────────── */

window.marginBorrow = async function(market) {
  const addr = window.STATE?.walletAddr;
  if (!addr) { toast('Connect wallet first', 'error'); return; }

  const input = $id('sui-borrow-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount < 0.1) { toast('Minimum borrow is 0.1 SUI', 'error'); return; }

  const rawAmount = Math.floor(amount * MARGIN.SUI_SCALAR);

  setBtnState('sui-borrow-btn', true);
  toast('Preparing borrow...');

  try {
    const managerId = await ensureMarginManager();

    const { Transaction } = await import('https://cdn.jsdelivr.net/npm/@mysten/sui@latest/+esm');
    const tx = new Transaction();

    tx.moveCall({
      target: `${MARGIN.PKG}::margin_manager::borrow_base`,
      typeArguments: [MARGIN.SUI_TYPE, MARGIN.DBUSDC_TYPE],
      arguments: [
        tx.object(managerId),
        tx.object(MARGIN.SUI_POOL),
        tx.pure.u64(rawAmount),
      ],
    });

    const digest = await window.signAndExecuteTransaction(tx);
    toast(`Borrowed ${amount} SUI ✓`, 'success');
    console.log('[Margin] Borrow digest:', digest);

    if (input) input.value = '';
    setTimeout(() => {
      fetchUserBalances(addr);
      updateRiskRatio(managerId);
    }, 2000);

  } catch (err) {
    console.error('[Margin] Borrow error:', err);
    toast(err.message?.slice(0, 60) || 'Borrow failed', 'error');
  } finally {
    setBtnState('sui-borrow-btn', false);
  }
};

/* ── SUPPLY TO POOL ─────────────────────────────────────────────── */

window.marginSupplyPool = async function(market) {
  const addr = window.STATE?.walletAddr;
  if (!addr) { toast('Connect wallet first', 'error'); return; }

  const input = $id('dbusdc-supply-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount < 0.1) { toast('Minimum supply is 0.1 DBUSDC', 'error'); return; }

  const rawAmount = Math.floor(amount * MARGIN.DBUSDC_SCALAR);

  setBtnState('dbusdc-supply-btn', true);
  toast('Preparing supply...');

  try {
    const coinId = await getCoinObject(addr, MARGIN.DBUSDC_TYPE, rawAmount);

    const { Transaction } = await import('https://cdn.jsdelivr.net/npm/@mysten/sui@latest/+esm');
    const tx = new Transaction();

    // Mint supplier cap if we don't have one
    let supplierCap;
    if (!MG.supplierCapId) {
      supplierCap = tx.moveCall({
        target: `${MARGIN.PKG}::margin_pool::mint_supplier_cap`,
        typeArguments: [MARGIN.DBUSDC_TYPE],
        arguments: [tx.object(MARGIN.DBUSDC_POOL)],
      });
    } else {
      supplierCap = tx.object(MG.supplierCapId);
    }

    const [supplyCoin] = tx.splitCoins(tx.object(coinId), [tx.pure.u64(rawAmount)]);

    tx.moveCall({
      target: `${MARGIN.PKG}::margin_pool::supply_to_margin_pool`,
      typeArguments: [MARGIN.DBUSDC_TYPE],
      arguments: [
        tx.object(MARGIN.DBUSDC_POOL),
        supplierCap,
        supplyCoin,
      ],
    });

    // Transfer supplier cap to user if newly minted
    if (!MG.supplierCapId) {
      tx.transferObjects([supplierCap], tx.pure.address(addr));
    }

    const digest = await window.signAndExecuteTransaction(tx);
    toast(`Supplied ${amount} DBUSDC ✓`, 'success');
    console.log('[Margin] Supply digest:', digest);

    if (input) input.value = '';
    setTimeout(() => {
      fetchUserBalances(addr);
      fetchPoolMetrics();
    }, 2000);

  } catch (err) {
    console.error('[Margin] Supply error:', err);
    toast(err.message?.slice(0, 60) || 'Supply failed', 'error');
  } finally {
    setBtnState('dbusdc-supply-btn', false);
  }
};

/* ── WITHDRAW FROM POOL ─────────────────────────────────────────── */

window.marginWithdraw = async function(market) {
  const addr = window.STATE?.walletAddr;
  if (!addr) { toast('Connect wallet first', 'error'); return; }

  const input = $id('dbusdc-withdraw-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount <= 0) { toast('Enter an amount', 'error'); return; }

  if (!MG.supplierCapId) { toast('No supply position found', 'error'); return; }

  const rawAmount = Math.floor(amount * MARGIN.DBUSDC_SCALAR);

  setBtnState('dbusdc-withdraw-btn', true);
  toast('Preparing withdrawal...');

  try {
    const { Transaction } = await import('https://cdn.jsdelivr.net/npm/@mysten/sui@latest/+esm');
    const tx = new Transaction();

    tx.moveCall({
      target: `${MARGIN.PKG}::margin_pool::withdraw_from_margin_pool`,
      typeArguments: [MARGIN.DBUSDC_TYPE],
      arguments: [
        tx.object(MARGIN.DBUSDC_POOL),
        tx.object(MG.supplierCapId),
        tx.pure.u64(rawAmount),
      ],
    });

    const digest = await window.signAndExecuteTransaction(tx);
    toast(`Withdrawn ${amount} DBUSDC ✓`, 'success');
    console.log('[Margin] Withdraw digest:', digest);

    if (input) input.value = '';
    setTimeout(() => {
      fetchUserBalances(addr);
      fetchPoolMetrics();
    }, 2000);

  } catch (err) {
    console.error('[Margin] Withdraw error:', err);
    toast(err.message?.slice(0, 60) || 'Withdrawal failed', 'error');
  } finally {
    setBtnState('dbusdc-withdraw-btn', false);
  }
};

/* ── RISK RATIO ─────────────────────────────────────────────────── */

async function updateRiskRatio(managerId) {
  if (!managerId) return;
  try {
    const res = await fetch(
      `${MARGIN.INDEXER}/margin_manager_states?margin_manager_id=${managerId}`
    );
    const data = await res.json();
    const state = Array.isArray(data) ? data[0] : data;
    if (!state) return;

    const ratio = Number(state.risk_ratio || 0);
    setEl('sui-risk-ratio', ratio.toFixed(2) + '×');

    // Fill bar: safe is 2.0+, liq is 1.1 — map to 0-100%
    const pct = ratio >= 2.0 ? 100
      : ratio <= 1.1 ? 0
      : ((ratio - 1.1) / (2.0 - 1.1)) * 100;
    const fill = $id('sui-risk-fill');
    if (fill) fill.style.width = pct + '%';

    // Credit available
    const baseAsset  = Number(state.base_asset  || 0) / MARGIN.SUI_SCALAR;
    const baseDebt   = Number(state.base_debt   || 0) / MARGIN.SUI_SCALAR;
    const credit     = Math.max(0, baseAsset * 0.8 - baseDebt);
    setEl('sui-credit', credit.toFixed(4) + ' SUI');
    setEl('sui-active-loan', baseDebt.toFixed(4) + ' SUI');

  } catch (err) {
    console.warn('[Margin] Risk ratio fetch failed:', err.message);
  }
}

/* ── CARD TAB SWITCH ────────────────────────────────────────────── */

window.switchCardTab = function(card, panel, btn) {
  // Deactivate all tabs in this card
  const cardEl = document.getElementById(`card-${card}`);
  if (!cardEl) return;
  cardEl.querySelectorAll('.card-tab').forEach(t => t.classList.remove('active'));
  cardEl.querySelectorAll('.card-panel').forEach(p => p.classList.remove('active'));

  btn.classList.add('active');
  const panelEl = document.getElementById(`${card}-panel-${panel}`);
  if (panelEl) panelEl.classList.add('active');
};

/* ── PAGE TAB SWITCH ────────────────────────────────────────────── */

window.switchMarketTab = function(market, btn) {
  document.querySelectorAll('.mg-page-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.mg-market-card').forEach(card => {
    card.style.display = card.dataset.market === market ? 'block' : 'none';
  });
};

/* ── WALLET CONNECT HOOK ────────────────────────────────────────── */

window.__vegaOrigFetchBalances = window._fetchWalletBalances;
window._fetchWalletBalances = async function(addr) {
  const _orig = window.__vegaOrigFetchBalances;
  if (_orig) await _orig(addr);
  fetchUserBalances(addr);

  const short = addr.slice(0, 6) + '...' + addr.slice(-4);
  const mgBtn = document.getElementById('mg-connect-btn');
  if (mgBtn) {
    mgBtn.textContent = short;
    mgBtn.classList.add('connected');
  }

  // Check for existing margin manager via on-chain owned objects
  try {
    const owned = await suiRpc('suix_getOwnedObjects', [
      addr,
      {
        filter: { StructType: `${MARGIN.PKG}::margin_manager::MarginManager` },
        options: { showContent: false },
      },
      null,
      5,
    ]);
    const existing = owned?.data?.[0]?.data?.objectId;
    if (existing) {
      MG.marginManagerId = existing;
      updateRiskRatio(existing);
    }
  } catch (_) {}
};

/* ── INIT ───────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  fetchPoolMetrics();

  // Poll metrics every 30s
  setInterval(fetchPoolMetrics, 30_000);
});
