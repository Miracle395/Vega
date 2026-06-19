/* ================================================================
   GAMBIT DEX — sui-wallet.js  v1.0
   Sui wallet connection layer.
   Supports: Sui Wallet (Chrome ext), Slush, and any wallet
   that injects window.suiWallet or implements the standard
   @mysten/wallet-standard interface.

   Replaces the MetaMask / Base chain handleConnect() in gambit.js.
   Drop this file in BEFORE gambit.js in index.html.

   After successful connection:
     STATE.connected   = true
     STATE.walletAddr  = '0x…'   (full Sui address)
     STATE.suiWallet   = <wallet object>
     All .btn-connect elements get the short address + .connected class
================================================================ */
'use strict';

/* ── SUI NETWORK CONFIG ─────────────────────────────────────── */
const SUI_CONFIG = {
  network: 'testnet',   // 'mainnet' | 'testnet' — flip this for prod

  mainnet: {
    chainId:  'sui:mainnet',
    rpcUrl:   'https://sui-mainnet.gateway.tatum.io',
    apiKey:   't-6a1314026dcffd29f3321133-cb8c2fb42a924934a367b95b',
    label:    'Sui Mainnet',
    explorer: 'https://suiscan.xyz/mainnet',
  },

  testnet: {
    chainId:  'sui:testnet',
    rpcUrl:   'https://sui-testnet.gateway.tatum.io',
    apiKey:   't-6a1314026dcffd29f3321133-b2b7fb9669494fdebadaf640',
    label:    'Sui Testnet',
    explorer: 'https://suiscan.xyz/testnet',
  },
};

function _suiCfg() {
  return SUI_CONFIG[SUI_CONFIG.network];
}

/* ── WALLET STANDARD REGISTRY ───────────────────────────── */

window.__suiRegisteredWallets =
  window.__suiRegisteredWallets || [];

/**
 * Wallet Standard registration listener.
 * Modern wallets announce themselves through events.
 */
window.addEventListener(
  'wallet-standard:register-wallet',
  (event) => {
    try {
      const detail = event.detail;

      // Wallet object directly supplied
      if (detail?.features) {

        if (
          !window.__suiRegisteredWallets.includes(detail)
        ) {
          window.__suiRegisteredWallets.push(detail);

          console.log(
            '[Wallet Standard] Registered:',
            detail.name
          );
        }

        return;
      }

      // Wallet Standard registrar callback — detail is a fn that expects { register }
      if (typeof detail === 'function') {
        detail({
          register: (...wallets) => {
            wallets.forEach(wallet => {
              if (!wallet) return;
              if (!window.__suiRegisteredWallets.includes(wallet)) {
                window.__suiRegisteredWallets.push(wallet);
                console.log('[Wallet Standard] Registered:', wallet.name);
              }
            });
          }
        });
        return;
      }

    } catch (err) {

      console.warn(
        '[Wallet Standard] Registration failed',
        err
      );

    }
  }
);

/* ── WALLET DETECTION ───────────────────────────────────────── */

/**
 * Returns the first available Sui wallet object, or null.
 * Priority: window.suiWallet → window.slush → wallet-standard registry
 */
function _detectSuiWallet() {

  // Official Sui Wallet
  if (window.suiWallet) {
    return window.suiWallet;
  }

  // Slush direct injection
  if (window.slush) {
    return window.slush;
  }

  // Wallet Standard registry
  const wallets =
    window.__suiRegisteredWallets || [];

  if (wallets.length) {

    const preferred = wallets.find(w =>
      w.name?.toLowerCase().includes('slush')
    );

    if (preferred) {
      return preferred;
    }

    const suiWallet = wallets.find(w =>
  w.chains?.some(chain =>
    chain.startsWith('sui:')
  ) ||
  w.accounts?.some(account =>
    account.chains?.some(chain =>
      chain.startsWith('sui:')
    )
  )
);

    if (suiWallet) {
      return suiWallet;
    }

    return wallets[0];
  }

  return null;
}

function _dispatchAppReady() {
  try {
    const ev = Object.assign(
      new Event('wallet-standard:app-ready', { bubbles: false, cancelable: false }),
      {
        detail: {
          register: (...wallets) => {
            wallets.forEach(w => {
              if (!w) return;
              if (!window.__suiRegisteredWallets.includes(w)) {
                window.__suiRegisteredWallets.push(w);
                console.log('[Wallet Standard] app-ready registered:', w.name);
              }
            });
          }
        }
      }
    );
    window.dispatchEvent(ev);
  } catch(e) { console.warn('[Sui] app-ready dispatch failed:', e); }
}

document.addEventListener('DOMContentLoaded', _dispatchAppReady);
window.addEventListener('load', _dispatchAppReady);

/**
 * Waits for a Sui wallet to become available.
 *
 * Supports:
 *  - Direct injection (window.suiWallet, window.slush)
 *  - Wallet Standard registration events
 *  - Delayed injection in mobile browsers (e.g. Mises)
 */
function _waitForSuiWallet(timeoutMs = 8000) {
  return new Promise((resolve) => {

    // Check immediately first
    const existing = _detectSuiWallet();
    if (existing) {
      resolve(existing);
      return;
    }

    let interval;
    let timeout;

    const cleanup = () => {
      clearInterval(interval);
      clearTimeout(timeout);

      window.removeEventListener(
        'wallet-standard:register-wallet',
        onWalletRegistered
      );
    };

    const finish = (wallet) => {
      cleanup();
      resolve(wallet);
    };

    const onWalletRegistered = () => {
      const wallet = _detectSuiWallet();

      if (wallet) {
        finish(wallet);
      }
    };

    // Listen for Wallet Standard registration
    window.addEventListener(
      'wallet-standard:register-wallet',
      onWalletRegistered
    );

    // Fallback polling for browsers/extensions
    // that inject late or don't fully follow the standard
    interval = setInterval(() => {
      const wallet = _detectSuiWallet();

      if (wallet) {
        finish(wallet);
      }
    }, 150);

    // Timeout
    timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    // Notify Wallet Standard wallets that the app is ready
    _dispatchAppReady();
  });
}

async function _fetchWalletBalances(addr) {
  try {
    const cfg = _suiCfg();
   const rpcUrl = cfg.rpcUrl;
const apiKey = cfg.apiKey;

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    // Fetch all coin balances
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'suix_getAllBalances',
        params: [addr],
      }),
    });
    const data = await res.json();
    const coins = data.result || [];

    // Parse SUI and USDC
    let suiBalance  = 0;
    let usdcBalance = 0;

    for (const coin of coins) {
      const type = coin.coinType || '';
      const amt  = Number(coin.totalBalance || 0);
      if (type === '0x2::sui::SUI') {
        suiBalance = amt / 1e9;
     } else if (type === '0xa8d7a62e9b0a8e9e7d0e3a5b1c2f4d6e8a0b2c4d6e8f0a2b4c6d8e0f2a4b6c8::dbusdc::DBUSDC' ||
                 type.toLowerCase().includes('dbusdc')) {
        usdcBalance = amt / 1e6;
      }
    }

    // Update STATE
    if (window.STATE) {
      window.STATE.suiBalance  = suiBalance;
      window.STATE.usdcBalance = usdcBalance;
      window.STATE.balance     = usdcBalance;
    }

    // Update trade panel balance display
    const balEl  = document.getElementById('trade-balance');
    const balElM = document.getElementById('trade-balance-m');
    const side   = window.tradeSide || 'buy';
    const label  = side === 'buy'
     ? usdcBalance.toFixed(2) + ' DBUSDC'
      : suiBalance.toFixed(4) + ' SUI';
    if (balEl)  balEl.textContent  = label;
    if (balElM) balElM.textContent = label;

    // Update account page balances panel
    const balPanel = document.getElementById('acct-balances');
    if (balPanel && window.STATE?.connected) {
      balPanel.innerHTML = `
        <div class="acct-token-row">
          <div class="acct-token-left">
            <span class="acct-token-badge sui">SUI</span>
            <span class="acct-token-name">Sui</span>
          </div>
          <div class="acct-token-right">
            <span class="acct-token-amount">${suiBalance.toFixed(4)}</span>
            <span class="acct-token-usd">SUI</span>
          </div>
        </div>
        <div class="acct-token-row">
          <div class="acct-token-left">
            <span class="acct-token-badge usdc">DBUSDC</span>
            <span class="acct-token-name">DeepBook USDC</span>
          </div>
          <div class="acct-token-right">
            <span class="acct-token-amount">${usdcBalance.toFixed(2)}</span>
            <span class="acct-token-usd">DBUSDC</span>
          </div>
        </div>
      `;
    }

    console.log('[Wallet] Balances - SUI: ' + suiBalance.toFixed(4) + ', DBUSDC: ' + usdcBalance.toFixed(2));
  } catch (err) {
    console.warn('[Wallet] Balance fetch failed:', err.message);
  }
}

// Expose so gambit.js can refresh after trades
window._fetchWalletBalances = _fetchWalletBalances;

/* ── CONNECT ────────────────────────────────────────────────── */

/**
 * handleConnect(btn)
 * Drop-in replacement for the MetaMask version in gambit.js.
 * Called by all .btn-connect elements via onclick.
 */
window.handleConnect = async function(btn) {
  // Already connected — do nothing (address already shown)
  if (window.STATE?.connected) return;

  // Disable button and show loading state
  if (btn) { btn.textContent = 'Connecting...'; btn.disabled = true; }

  // Force-clear any cached session so a locked wallet always prompts
  try {
    const stale = _detectSuiWallet();
    if (stale) {
      const df = stale.features?.['standard:disconnect'];
      if (typeof df?.disconnect === 'function') await df.disconnect();
      else if (typeof stale.disconnect === 'function') await stale.disconnect();
    }
  } catch (_) { /* best-effort — not all wallets support disconnect */ }

  _dispatchAppReady();

  // Wait for wallet injection
  const wallet = await _waitForSuiWallet();

  if (!wallet) {
    // No Sui wallet installed
    if (btn) { btn.textContent = 'Install Sui Wallet'; btn.disabled = false; }

    // Open Sui Wallet Chrome extension page
    const installUrl = 'https://chrome.google.com/webstore/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil';
    const tip = document.createElement('div');
    tip.className   = 'nav-soon-tooltip';
    tip.innerHTML   = 'No Sui wallet detected. <a href="' + installUrl + '" target="_blank" style="color:var(--gold)">Install Sui Wallet &rarr;</a>';
    tip.style.top   = (btn?.getBoundingClientRect().bottom + 8 || 60) + 'px';
    tip.style.left  = (btn?.getBoundingClientRect().left || 20) + 'px';
    document.body.appendChild(tip);
    setTimeout(() => {

  tip.remove();

  if (btn) {
    btn.textContent = 'Connect';
    btn.disabled = false;
  }

}, 4000);

return;
  }

  try {
    // ── Request accounts ────────────────────────────────────
    let accounts;

    // wallet-standard connect
    if (typeof wallet.features?.['standard:connect']?.connect === 'function') {
      const res = await wallet.features['standard:connect'].connect();
      accounts = res.accounts;
    }
    // Legacy suiWallet API
    else if (typeof wallet.requestPermissions === 'function') {
      await wallet.requestPermissions();
      accounts = await wallet.getAccounts();
    }
    // Slush / other
    else if (typeof wallet.connect === 'function') {
      const res = await wallet.connect();
      accounts = res?.accounts || res;
    }
    else {
      throw new Error('Unrecognised wallet API — cannot request accounts');
    }

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts returned from wallet');
    }

    // ── Pull address ─────────────────────────────────────────
    // Slush returns account objects with non-enumerable props (show as {} in JSON).
    // Try every known location before giving up.
    const account = accounts[0];
    const addr = (
      (typeof account === 'string' ? account : null) ||
      account?.address ||
      account?.publicKey ||
      null
    );

    console.log('[Sui Wallet] Raw account:', account, '| addr:', addr);

    if (!addr || typeof addr !== 'string') {
      throw new Error('Wallet returned invalid address — got: ' + JSON.stringify(account));
    }

    // ── Update STATE ──────────────────────────────────────────
    if (window.STATE) {
      window.STATE.connected  = true;
      window.STATE.walletAddr = addr;
      window.STATE.suiWallet  = wallet;
    }

    // ── Update UI ─────────────────────────────────────────────
const short = addr.slice(0, 6) + '...' + addr.slice(-4);

 document.querySelectorAll('.btn-connect').forEach(b => {
      b.textContent = short;
      b.classList.add('connected');
      b.disabled = false;
    });

    // Swap action button
    const swapBtn = document.getElementById('swap-action-btn');
    if (swapBtn) {
      swapBtn.textContent = 'Swap';
      swapBtn.onclick = window.executeSwap;
    }

    // Sync trade CTA button text
    if (typeof window._syncSubmitBtn === 'function') window._syncSubmitBtn();
    // Small delay so gambit.js STATE.connected is readable before updateCTA runs
    setTimeout(() => {
  if (typeof window.updateCTA === 'function') window.updateCTA();
}, 300);
    if (typeof window._updateAccountPage === 'function') window._updateAccountPage();
    
    _fetchWalletBalances(addr);

    console.log('[Sui Wallet] Connected: ' + addr + ' on ' + _suiCfg().label);

    // ── Account change listener ───────────────────────────────
    try {
      const changeFeature = wallet.features?.['standard:events'];
      if (changeFeature?.on) {
        changeFeature.on('change', ({ accounts: newAccs }) => {
          if (!newAccs || newAccs.length === 0) {
            _disconnectSuiWallet();
          } else {
            const newAddr  = newAccs[0].address || newAccs[0];
  const newShort = newAddr.slice(0, 6) + '...' + newAddr.slice(-4);
            if (window.STATE) window.STATE.walletAddr = newAddr;
            document.querySelectorAll('.btn-connect').forEach(b => b.textContent = newShort);
          }
        });
      }
    } catch (_) { /* listener setup is best-effort */ }

  } catch (err) {
    console.error('[Sui Wallet] Connection error:', err);

    if (btn) {
      btn.textContent = err.message?.includes('rejected') || err.code === 4001
        ? 'Rejected'
        : 'Connect';
      btn.disabled = false;
      setTimeout(() => {
        if (btn.textContent === 'Rejected') btn.textContent = 'Connect';
      }, 2000);
    }
  }
};

/* ── DISCONNECT ─────────────────────────────────────────────── */

window._disconnectSuiWallet = function() {
  if (window.STATE) {
    window.STATE.connected  = false;
    window.STATE.walletAddr = null;
    window.STATE.suiWallet  = null;
  }

  document.querySelectorAll('.btn-connect').forEach(b => {
    b.textContent = 'Connect';
    b.classList.remove('connected');
    b.disabled = false;
  });

  const swapBtn = document.getElementById('swap-action-btn');
  if (swapBtn) {
    swapBtn.textContent = 'Connect Wallet';
    swapBtn.onclick = () => window.handleConnect(document.getElementById('btn-connect'));
  }

  if (typeof window.updateCTA === 'function') window.updateCTA();
  console.log('[Sui Wallet] Disconnected');
};

// Keep original name working in case gambit.js calls it
window._disconnectWallet = window._disconnectSuiWallet;

/* ── SIGN & EXECUTE TRANSACTION ─────────────────────────────── */

/**
 * signAndExecuteTransaction(txBytes)
 *
 * Signs and submits a built transaction block.
 * Returns the Sui transaction digest.
 *
 * @param {Uint8Array|string} txBytes — serialised TransactionBlock bytes
 * @returns {Promise<string>} txDigest
 */
window.signAndExecuteTransaction = async function(txBytes) {
  const wallet = window.STATE?.suiWallet;
  if (!wallet) throw new Error('Wallet not connected');

  // Modern wallet-standard: passes Transaction object directly (Slush, Sui Wallet ≥ 0.10)
  const feature = wallet.features?.['sui:signAndExecuteTransaction'];
  if (feature?.signAndExecuteTransaction) {
    const result = await feature.signAndExecuteTransaction({
      transaction: txBytes,   // Aftermath returns a Transaction object — passed through as-is
      account:     wallet.accounts?.[0] || { address: window.STATE.walletAddr },
      chain:       _suiCfg().chainId,
      options: { showEffects: true, showObjectChanges: true },
    });
    return result.digest || result.effects?.transactionDigest;
  }

  // Legacy fallback: serialize to bytes first
  const legacyFeature = wallet.features?.['sui:signAndExecuteTransactionBlock'];
  if (legacyFeature?.signAndExecuteTransactionBlock) {
    // If txBytes is a Transaction object, build to bytes; otherwise pass through
    // Pass the Transaction object directly — legacy wallets that truly need bytes
    // will handle serialization internally. Calling .build() requires a SuiClient
    // which we don't have here, so pass through and let the wallet handle it.
    const block = txBytes;
    const result = await legacyFeature.signAndExecuteTransactionBlock({
      transactionBlock: block,
      account:          wallet.accounts?.[0] || { address: window.STATE.walletAddr },
      chain:            _suiCfg().chainId,
      options: { showEffects: true, showObjectChanges: true },
    });
    return result.digest || result.effects?.transactionDigest;
  }

  // Bare object last resort
  if (typeof wallet.signAndExecuteTransactionBlock === 'function') {
    const result = await wallet.signAndExecuteTransactionBlock({
      transactionBlock: txBytes,
      options: { showEffects: true },
    });
    return result.digest;
  }

  throw new Error('Wallet does not support signAndExecuteTransaction');
};

/* ── NETWORK BADGE ──────────────────────────────────────────── */
function _showNetworkBadge() {
  // Remove any existing badge
  document.getElementById('sui-network-badge')?.remove();

  if (SUI_CONFIG.network === 'mainnet') return; // Don't show on mainnet

  const badge = document.createElement('div');
  badge.id          = 'sui-network-badge';
  badge.textContent = 'TESTNET';
  badge.style.cssText = [
    'position:fixed',
    'bottom:12px',
    'left:12px',
    'z-index:9999',
    'background:rgba(212,175,55,0.12)',
    'border:1px solid rgba(212,175,55,0.35)',
    'color:#d4af37',
    'font-family:var(--mono,monospace)',
    'font-size:9px',
    'font-weight:600',
    'letter-spacing:0.12em',
    'padding:3px 7px',
    'border-radius:2px',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(badge);
}

/* ── RUNTIME NETWORK SWITCH ─────────────────────────────────── */
window.suiSetNetwork = function(n) {
  if (n !== 'mainnet' && n !== 'testnet') {
    throw new Error('suiSetNetwork: must be "mainnet" or "testnet"');
  }
  SUI_CONFIG.network = n;
  // Keep in sync with walrus.js
  if (typeof window.walrusSetNetwork === 'function') window.walrusSetNetwork(n);
  console.log('[Sui] Network switched to ' + n);
  _showNetworkBadge();
};
