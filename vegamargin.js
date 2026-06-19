'use strict';

/* ================================================================
   VEGA MARGIN — vegamargin.js
   UI layer only. All transaction execution delegated to
   vega-margin-executor.js — mirrors how vega.js uses vega-executor.js.
================================================================ */

/* ── CONSTANTS ──────────────────────────────────────────────────── */

const MARGIN = {
  SUI_TYPE:      '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  DBUSDC_TYPE:   '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC',
  SUI_SCALAR:    1_000_000_000,
  DBUSDC_SCALAR: 1_000_000,
};

/* ── STATE ──────────────────────────────────────────────────────── */

const MG = {
  poolMetrics:  {},
  userBalances: {},
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

/* ── APR MODEL ──────────────────────────────────────────────────── */
// Piecewise linear — same model as Aave/Compound
// 0→80% util: BASE → S1 (2%→20%)
// 80→100% util: S1 → S2 (20%→150%)

function computeAPR(totalSupply, totalBorrow) {
  if (totalSupply === 0) return { borrowAPR: 0.02, supplyAPR: 0, util: 0 };
  const util   = totalBorrow / totalSupply;
  const BASE   = 0.02;
  const KINK   = 0.80;
  const S1     = 0.20;
  const S2     = 1.50;
  const SPREAD = 0.10;

  const borrowAPR = util <= KINK
    ? BASE + (util / KINK) * (S1 - BASE)
    : S1 + ((util - KINK) / (1 - KINK)) * (S2 - S1);

  const supplyAPR = borrowAPR * util * (1 - SPREAD);
  return { borrowAPR, supplyAPR, util };
}

/* ── POOL METRICS ───────────────────────────────────────────────── */

async function fetchPoolMetrics() {
  const metrics = await window.fetchMarginPoolMetrics?.();
  if (!metrics) return;

  MG.poolMetrics.sui    = metrics.sui;
  MG.poolMetrics.dbusdc = metrics.dbusdc;
  renderPoolMetrics();
}

function renderPoolMetrics() {
  const sui = MG.poolMetrics.sui;
  const db  = MG.poolMetrics.dbusdc;

  if (sui) {
    const { borrowAPR, supplyAPR, util } = computeAPR(sui.totalSupply, sui.totalBorrows);
    const liq = sui.totalSupply - sui.totalBorrows;
    const pct = Math.min((util || 0) * 100, 100);

    setEl('sui-liquidity',    fmtAmt(liq, MARGIN.SUI_SCALAR) + ' SUI');
    setEl('sui-borrow-apr',   fmtPct(borrowAPR));
    setEl('sui-borrow-apr-2', fmtPct(borrowAPR));
    setEl('sui-deposit-apr',  fmtPct(supplyAPR));

    const fill = $id('mg-health-fill');
    if (fill) fill.style.width = pct + '%';
    setEl('mg-util-pct',     pct.toFixed(1) + '%');
    setEl('mg-utilization',  pct.toFixed(1) + '%');
    setEl('mg-active-loans', fmtAmt(sui.totalBorrows, MARGIN.SUI_SCALAR) + ' SUI');
  }

  if (db) {
    const { supplyAPR } = computeAPR(db.totalSupply, db.totalBorrows);
    setEl('dbusdc-total-supply', fmtAmt(db.totalSupply, MARGIN.DBUSDC_SCALAR) + ' DBUSDC');
    setEl('dbusdc-supply-apr',   fmtPct(supplyAPR));
    setEl('dbusdc-apy',          fmtPct(supplyAPR));
    setEl('dbusdc-earn-rate',    fmtPct(supplyAPR));
    setEl('mg-total-deposits',   fmtAmt(db.totalSupply, MARGIN.DBUSDC_SCALAR) + ' DBUSDC');
  }
}

/* ── USER BALANCES ──────────────────────────────────────────────── */

async function fetchUserBalances(addr) {
  // Delegate to vega-wallet.js balance fetch if available,
  // then read STATE which it populates
  if (typeof window._refreshWalletBalances === 'function') {
    await window._refreshWalletBalances();
  }

  // Read from STATE (populated by vega-wallet.js)
  const suiBal    = window.STATE?.suiBalance   || 0;
  const dbusdcBal = window.STATE?.usdcBalance  || 0;

  MG.userBalances.sui    = suiBal;
  MG.userBalances.dbusdc = dbusdcBal;

  setEl('sui-deposit-balance', dbusdcBal.toFixed(2));
  setEl('sui-supply-balance',  dbusdcBal.toFixed(2));
  setEl('dbusdc-wallet-bal',   dbusdcBal.toFixed(2) + ' DBUSDC');
}

/* ── RISK RATIO ─────────────────────────────────────────────────── */

async function updateRiskRatio(managerId) {
  if (!managerId) return;

  const data = await window.fetchMarginRiskRatio?.(managerId);
  if (!data) return;

  const { ratio, baseAsset, baseDebt } = data;

  setEl('sui-risk-ratio', baseDebt > 0 ? ratio.toFixed(2) + '×' : '—');

  const pct = ratio >= 2.0 ? 100
    : ratio <= 1.1 ? 0
    : ((ratio - 1.1) / (2.0 - 1.1)) * 100;

  const fill = $id('sui-risk-fill');
  if (fill) fill.style.width = (baseDebt > 0 ? pct : 0) + '%';

  const credit = Math.max(0, baseAsset * 0.8 - baseDebt);
  setEl('sui-credit',      credit.toFixed(4) + ' SUI');
  setEl('sui-active-loan', baseDebt.toFixed(4) + ' SUI');
}

/* ── DEPOSIT ────────────────────────────────────────────────────── */

window.marginDeposit = async function() {
  if (!window.STATE?.walletAddr) { toast('Connect wallet first', 'error'); return; }

  const input  = $id('sui-deposit-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount <= 0) { toast('Enter an amount', 'error'); return; }

  setBtnState('sui-deposit-btn', true);
  toast('Preparing deposit...');

  try {
    const { txDigest } = await window.executeMarginDeposit({ amount });
    toast(`Deposited ${amount} DBUSDC ✓`, 'success');
    console.log('[Margin] Deposit:', txDigest);
    if (input) input.value = '';
    setTimeout(() => fetchUserBalances(window.STATE.walletAddr), 2500);
  } catch (err) {
    console.error('[Margin] Deposit error:', err);
    toast(err.message?.slice(0, 80) || 'Deposit failed', 'error');
  } finally {
    setBtnState('sui-deposit-btn', false);
  }
};

/* ── BORROW ─────────────────────────────────────────────────────── */

window.marginBorrow = async function() {
  if (!window.STATE?.walletAddr) { toast('Connect wallet first', 'error'); return; }

  const input  = $id('sui-borrow-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount < 0.1) { toast('Minimum borrow is 0.1 SUI', 'error'); return; }

  setBtnState('sui-borrow-btn', true);
  toast('Preparing borrow...');

  try {
    const { txDigest } = await window.executeMarginBorrow({ amount });
    toast(`Borrowed ${amount} SUI ✓`, 'success');
    console.log('[Margin] Borrow:', txDigest);
    if (input) input.value = '';
    setTimeout(async () => {
      await fetchUserBalances(window.STATE.walletAddr);
      const managerId = window._marginManagerId;
      if (managerId) updateRiskRatio(managerId);
    }, 2500);
  } catch (err) {
    console.error('[Margin] Borrow error:', err);
    toast(err.message?.slice(0, 80) || 'Borrow failed', 'error');
  } finally {
    setBtnState('sui-borrow-btn', false);
  }
};

/* ── SUPPLY ─────────────────────────────────────────────────────── */

window.marginSupplyPool = async function() {
  if (!window.STATE?.walletAddr) { toast('Connect wallet first', 'error'); return; }

  const input  = $id('dbusdc-supply-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount < 0.1) { toast('Minimum supply is 0.1 DBUSDC', 'error'); return; }

  setBtnState('dbusdc-supply-btn', true);
  toast('Preparing supply...');

  try {
    const { txDigest } = await window.executeMarginSupply({ amount });
    toast(`Supplied ${amount} DBUSDC ✓`, 'success');
    console.log('[Margin] Supply:', txDigest);
    if (input) input.value = '';
    setTimeout(() => {
      fetchUserBalances(window.STATE.walletAddr);
      fetchPoolMetrics();
    }, 2500);
  } catch (err) {
    console.error('[Margin] Supply error:', err);
    toast(err.message?.slice(0, 80) || 'Supply failed', 'error');
  } finally {
    setBtnState('dbusdc-supply-btn', false);
  }
};

/* ── WITHDRAW ───────────────────────────────────────────────────── */

window.marginWithdraw = async function() {
  if (!window.STATE?.walletAddr) { toast('Connect wallet first', 'error'); return; }

  const input  = $id('dbusdc-withdraw-input');
  const amount = parseFloat(input?.value);
  if (!amount || amount <= 0) { toast('Enter an amount', 'error'); return; }

  setBtnState('dbusdc-withdraw-btn', true);
  toast('Preparing withdrawal...');

  try {
    const { txDigest } = await window.executeMarginWithdraw({ amount });
    toast(`Withdrawn ${amount} DBUSDC ✓`, 'success');
    console.log('[Margin] Withdraw:', txDigest);
    if (input) input.value = '';
    setTimeout(() => {
      fetchUserBalances(window.STATE.walletAddr);
      fetchPoolMetrics();
    }, 2500);
  } catch (err) {
    console.error('[Margin] Withdraw error:', err);
    toast(err.message?.slice(0, 80) || 'Withdrawal failed', 'error');
  } finally {
    setBtnState('dbusdc-withdraw-btn', false);
  }
};

/* ── CARD TAB SWITCH ────────────────────────────────────────────── */

window.switchCardTab = function(card, panel, btn) {
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
  // Run original wallet balance fetch first
  const _orig = window.__vegaOrigFetchBalances;
  if (_orig) await _orig(addr);

  // Update margin page button
  const short = addr.slice(0, 6) + '...' + addr.slice(-4);
  const mgBtn = document.getElementById('mg-connect-btn');
  if (mgBtn) {
    mgBtn.textContent = short;
    mgBtn.classList.add('connected');
  }

  // Sync balances to margin UI
  fetchUserBalances(addr);

  // Check for existing margin manager on-chain
  try {
    const managerId = await window.ensureMarginManager?.();
    if (managerId) updateRiskRatio(managerId);
  } catch (_) {}
};

/* ── INIT ───────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  fetchPoolMetrics();
  setInterval(fetchPoolMetrics, 30_000);
});
