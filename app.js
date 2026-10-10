// Shared helpers for all pages (plain script, exposes window.App).
(function () {
  const API = (window.APP_CONFIG || {}).apiUrl || '/api';

  class ApiError extends Error {
    constructor(res) {
      super(res.message || 'שגיאה');
      Object.assign(this, res);
    }
  }

  async function api(action, payload, { session } = {}) {
    let res;
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session ? { 'x-session': session } : {}) },
        body: JSON.stringify({ action, payload }),
      });
      res = await r.json();
    } catch {
      throw new ApiError({ error: 'network', message: 'אין חיבור לשרת. בדוק את האינטרנט ונסה שוב.' });
    }
    if (!res.ok) throw new ApiError(res);
    return res.data;
  }

  // h('div', {class: 'x', onclick: fn}, 'text', child, [children])
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    const add = (c) => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }

  const TZ = 'Asia/Jerusalem';
  const fmtTime = (iso) => (iso ? new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '');
  const fmtDate = (iso) => (iso ? new Intl.DateTimeFormat('he-IL', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso)) : '');
  const fmtDateTime = (iso) => (iso ? `${fmtDate(iso)} ${fmtTime(iso)}` : '');
  const fmtPlate = (p) => {
    p = String(p || '');
    if (p.length === 7) return `${p.slice(0, 2)}-${p.slice(2, 5)}-${p.slice(5)}`;
    if (p.length === 8) return `${p.slice(0, 3)}-${p.slice(3, 5)}-${p.slice(5)}`;
    return p;
  };
  const fmtPhone = (p) => (p && p.length === 10 ? `${p.slice(0, 3)}-${p.slice(3)}` : p || '');

  const STATUS = {
    pending: 'ממתין לאישור',
    approved: 'אושר',
    rejected: 'נדחה',
    denied: 'נחסם',
    expired: 'פג תוקף',
    cancelled: 'בוטל',
  };
  const RECONCILE = { recorded: 'נרשם ומאושר', discrepancy: 'חריגה' };
  const FUEL = { petrol95: 'בנזין 95', petrol98: 'בנזין 98', diesel: 'סולר', adblue: 'AdBlue', other: 'אחר' };
  const ROLES = { admin: 'מנהל', controller: 'בקר שוברים', station: 'עמדת תחנה' };

  let toastTimer;
  function toast(msg, isErr) {
    let t = document.getElementById('toast');
    if (!t) {
      t = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' });
      document.body.append(t);
    }
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), isErr ? 6000 : 3000);
  }

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };

  const qs = (k) => new URLSearchParams(location.search).get(k);

  window.App = { api, ApiError, h, fmtTime, fmtDate, fmtDateTime, fmtPlate, fmtPhone, STATUS, RECONCILE, FUEL, ROLES, toast, store, qs };
})();
