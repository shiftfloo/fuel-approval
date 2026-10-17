// Staff screen: live monitor, voucher control, admin tables, audit log.
(function () {
  const { api, h, fmtTime, fmtDate, fmtDateTime, fmtPlate, fmtPhone, STATUS, RECONCILE, FUEL, ROLES, toast, store } = App;
  const main = document.getElementById('main');
  const dlg = document.getElementById('dlg');
  let session = store.get('fuel.session');
  let me = null;
  let lookups = { stations: [], companies: [], approvers: [] };
  let refreshTimer = null;

  const call = (action, payload) => api(action, payload, { session }).catch((e) => {
    if (e.error === 'auth') {
      store.set('fuel.session', null);
      session = null;
      showLogin();
    }
    throw e;
  });

  const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jerusalem' });
  const addDays = (d, n) => {
    const x = new Date(d + 'T00:00:00');
    x.setDate(x.getDate() + n);
    return x.toLocaleDateString('sv-SE');
  };
  // Israel-local midnight for a yyyy-mm-dd string, sent to the server as an instant.
  function dayStart(d) {
    const guess = new Date(d + 'T00:00:00Z');
    const local = new Date(guess.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    return new Date(guess.getTime() - (local.getTime() - guess.getTime())).toISOString();
  }

  const pill = (status) => h('span', { class: 'pill ' + status }, STATUS[status] || RECONCILE[status] || status);

  // ---------- login ----------

  async function boot() {
    if (session) {
      try {
        const r = await call('auth.me');
        me = r.user;
        document.getElementById('orgName').textContent = r.org_name;
        App.smsProvider = r.sms_provider;
        return showApp();
      } catch {
        /* falls through to login */
      }
    }
    showLogin();
  }

  async function showLogin() {
    clearInterval(refreshTimer);
    document.getElementById('logoutBtn').classList.add('hidden');
    document.getElementById('userName').textContent = '';
    let needsSetup = false;
    try {
      needsSetup = (await api('auth.needsSetup')).needsSetup;
    } catch (e) {
      main.replaceChildren(h('div', { class: 'card' }, e.message));
      return;
    }
    const err = h('div', { class: 'error hidden', role: 'alert' });
    const form = h('form', { class: 'card', style: 'max-width:420px;margin:40px auto' },
      h('h1', null, needsSetup ? 'הגדרה ראשונית - מנהל מערכת' : 'כניסה למערכת'),
      needsSetup ? h('p', { class: 'muted small' }, 'אין עדיין משתמשים. צור את משתמש המנהל הראשון.') : null,
      needsSetup ? [h('label', { for: 'name' }, 'שם מלא'), h('input', { id: 'name', required: true })] : null,
      h('label', { for: 'username' }, 'שם משתמש'),
      h('input', { id: 'username', autocomplete: 'username', required: true, dir: 'ltr' }),
      h('label', { for: 'password' }, 'סיסמה'),
      h('input', { id: 'password', type: 'password', autocomplete: needsSetup ? 'new-password' : 'current-password', required: true, dir: 'ltr' }),
      err,
      h('button', { class: 'primary block', type: 'submit' }, needsSetup ? 'יצירה וכניסה' : 'כניסה'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      const v = (id) => form.querySelector('#' + id)?.value;
      try {
        const r = needsSetup
          ? await api('auth.setup', { name: v('name'), username: v('username'), password: v('password') })
          : await api('auth.login', { username: v('username'), password: v('password') });
        session = r.token;
        store.set('fuel.session', session);
        boot();
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });
    main.replaceChildren(form);
  }

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try { await call('auth.logout'); } catch {}
    store.set('fuel.session', null);
    session = null;
    showLogin();
  });

  // ---------- shell ----------

  // Work order: set up customers (with their approvers and vehicles), then daily monitoring and voucher control.
  // Stations and users are set up rarely, so they live under Settings.
  const GROUPS = {
    customers: [
      { id: 'companies', label: 'לקוחות', render: () => renderTable('companies') },
      { id: 'approvers', label: 'מאשרים', render: () => renderTable('approvers') },
      { id: 'vehicles', label: 'רכבים', render: () => renderTable('vehicles') },
    ],
    settings: [
      { id: 'general', label: 'כללי', render: () => renderGeneral() },
      { id: 'stations', label: 'תחנות ו-QR', render: () => renderTable('stations') },
      { id: 'users', label: 'משתמשים', render: () => renderTable('users') },
    ],
  };
  const TABS = [
    { id: 'customers', label: 'לקוחות', roles: ['admin'], render: () => renderGroup('customers') },
    { id: 'monitor', label: 'מעקב בקשות', roles: ['admin', 'controller', 'station'], render: renderMonitor },
    { id: 'outbox', label: 'הודעות SMS', roles: ['admin'], render: renderOutbox },
    { id: 'reconcile', label: 'בקרת שוברים', roles: ['admin', 'controller'], render: renderReconcile },
    { id: 'audit', label: 'יומן ביקורת', roles: ['admin', 'controller'], render: renderAudit },
    { id: 'settings', label: 'הגדרות', roles: ['admin'], render: () => renderGroup('settings') },
  ];
  // links saved before the menu was regrouped
  const OLD_HASH = {
    companies: 'customers/companies', approvers: 'customers/approvers', vehicles: 'customers/vehicles',
    stations: 'settings/stations', users: 'settings/users',
  };
  const groupSub = { customers: 'companies', settings: 'general' };

  let body;
  let pane; // where the current tab draws (body, or the settings sub-pane)
  let current;

  async function showApp() {
    document.getElementById('logoutBtn').classList.remove('hidden');
    document.getElementById('userName').textContent = `${me.name} · ${ROLES[me.role]}`;
    try {
      lookups = await call('admin.lookups');
    } catch {}
    const tabs = TABS.filter((t) => t.roles.includes(me.role));
    const bar = h('nav', { class: 'tabs no-print', role: 'tablist' });
    body = h('section');
    const banner = App.smsProvider === 'demo' && me.role === 'admin'
      ? h('div', { class: 'note small no-print', style: 'margin-bottom:12px' },
        'מצב הדגמה: הודעות SMS לא נשלחות באמת. ההודעות והקודים מופיעים בלשונית "הודעות SMS".')
      : null;
    for (const t of tabs) {
      bar.append(h('button', { type: 'button', role: 'tab', 'data-tab': t.id, onclick: () => go(t.id) }, t.label));
    }
    main.replaceChildren(banner || '', bar, body);
    const [want, sub] = (OLD_HASH[location.hash.slice(1)] || location.hash.slice(1)).split('/');
    if (sub && GROUPS[want]?.some((t) => t.id === sub)) groupSub[want] = sub;
    // daily work starts at the monitor; the tab order follows the setup order
    go(tabs.some((t) => t.id === want) ? want : tabs.some((t) => t.id === 'monitor') ? 'monitor' : tabs[0].id);
  }

  function go(id) {
    clearInterval(refreshTimer);
    current = id;
    pane = body;
    history.replaceState(null, '', '#' + id + (GROUPS[id] ? '/' + groupSub[id] : ''));
    main.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === id);
      b.setAttribute('aria-selected', b.dataset.tab === id);
    });
    pane.replaceChildren(h('div', { class: 'muted' }, 'טוען…'));
    TABS.find((t) => t.id === id).render();
  }

  // ---------- dialog ----------

  function openDialog(title, content, footer) {
    dlg.replaceChildren(
      h('div', { class: 'dlg-head' }, h('h2', null, title), h('button', { type: 'button', class: 'link', 'aria-label': 'סגירה', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'dlg-body' }, content),
      footer ? h('div', { class: 'dlg-foot' }, footer) : '');
    if (!dlg.open) dlg.showModal();
  }

  // ---------- monitor ----------

  const monitorState = { from: null, to: null, status: '', station_id: '', q: '' };

  function renderMonitor() {
    monitorState.from ??= todayStr();
    monitorState.to ??= todayStr();
    const statusSel = h('select', { id: 'fStatus' },
      h('option', { value: '' }, 'הכל'),
      h('option', { value: 'unreconciled' }, 'אושר - טרם נבדק שובר'),
      Object.entries(STATUS).map(([k, v]) => h('option', { value: k }, v)));
    statusSel.value = monitorState.status;
    const stationSel = me.role === 'station' ? null : h('select', { id: 'fStation' },
      h('option', { value: '' }, 'כל התחנות'),
      lookups.stations.map((s) => h('option', { value: s.id }, s.name)));
    if (stationSel) stationSel.value = monitorState.station_id;
    const from = h('input', { type: 'date', id: 'fFrom', value: monitorState.from });
    const to = h('input', { type: 'date', id: 'fTo', value: monitorState.to });
    const q = h('input', { type: 'search', id: 'fQ', placeholder: 'רכב / נהג / מספר אישור', value: monitorState.q });
    const stats = h('div', { class: 'stats' });
    const tableWrap = h('div', { class: 'table-wrap' });
    let rows = [];

    const lbl = (text, el) => h('div', null, h('label', { for: el.id }, text), el);
    const exportBtn = h('button', { type: 'button' }, 'ייצוא לאקסל (CSV)');
    exportBtn.addEventListener('click', () => exportCsv(rows));

    async function load() {
      Object.assign(monitorState, { from: from.value, to: to.value, status: statusSel.value, station_id: stationSel?.value || '', q: q.value.trim() });
      try {
        rows = await call('monitor.list', {
          from: monitorState.from ? dayStart(monitorState.from) : null,
          to: monitorState.to ? dayStart(addDays(monitorState.to, 1)) : null,
          status: monitorState.status || null,
          station_id: monitorState.station_id || null,
          q: monitorState.q || null,
        });
      } catch (e) {
        tableWrap.replaceChildren(h('div', { class: 'error' }, e.message));
        return;
      }
      const c = (f) => rows.filter(f).length;
      stats.replaceChildren(
        stat(rows.length, 'בקשות'),
        stat(c((r) => r.status === 'pending'), 'ממתינות'),
        stat(c((r) => r.status === 'approved'), 'אושרו'),
        stat(c((r) => r.status === 'approved' && !r.reconcile_status), 'טרם נבדק שובר'),
        stat(c((r) => ['rejected', 'denied'].includes(r.status)), 'נדחו / נחסמו'));
      tableWrap.replaceChildren(requestsTable(rows));
    }

    [from, to, statusSel, stationSel].forEach((el) => el && el.addEventListener('change', load));
    let qTimer;
    q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(load, 300); });

    pane.replaceChildren(
      h('div', { class: 'toolbar no-print' },
        lbl('מתאריך', from), lbl('עד תאריך', to), lbl('סטטוס', statusSel),
        stationSel ? lbl('תחנה', stationSel) : null, lbl('חיפוש', q),
        h('div', null, h('label', null, ' '), exportBtn)),
      stats, tableWrap,
      h('p', { class: 'muted small' }, 'הרשימה מתעדכנת אוטומטית כל 10 שניות.'));
    load();
    refreshTimer = setInterval(() => { if (!dlg.open && !document.hidden) load(); }, 10000);
  }

  const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v num' }, v), h('div', { class: 'l' }, l));

  function requestsTable(rows) {
    if (!rows.length) return h('p', { class: 'muted', style: 'padding:14px' }, 'אין בקשות בטווח שנבחר.');
    return h('table', null,
      h('thead', null, h('tr', null, ['#', 'שעה', 'תחנה', 'רכב', 'לקוח', 'נהג', 'כמות', 'סטטוס', 'מספר אישור', 'מאשר', 'שובר'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((r) => h('tr', { class: 'click', tabindex: '0', onclick: () => openRequest(r.id), onkeydown: (e) => e.key === 'Enter' && openRequest(r.id) },
        h('td', { class: 'num' }, r.request_no),
        h('td', { class: 'num' }, fmtDate(r.created_at) === fmtDate(new Date().toISOString()) ? fmtTime(r.created_at) : fmtDateTime(r.created_at)),
        h('td', null, r.station_name),
        h('td', { class: 'num' }, r.plate_fmt),
        h('td', null, r.company_name || '-'),
        h('td', null, r.driver_name),
        h('td', null, r.status === 'approved' ? r.approved_text : r.amount_text),
        h('td', null, pill(r.status), r.over_limit ? h('div', { class: 'small', style: 'color:var(--bad)' }, 'מעל המכסה') : null),
        h('td', { class: 'num' }, r.approval_no || ''),
        h('td', null, r.approver_name || ''),
        h('td', null, r.status === 'approved' ? pill(r.reconcile_status || 'todo') : '')))));
  }
  RECONCILE.todo = 'טרם נבדק';

  function exportCsv(rows) {
    const cols = [
      ['request_no', 'מס׳ בקשה'], ['created_at', 'נוצרה', fmtDateTime], ['station_name', 'תחנה'], ['plate_fmt', 'רכב'],
      ['vehicle_desc', 'תיאור רכב'], ['company_name', 'לקוח'], ['driver_name', 'נהג'], ['driver_phone', 'טלפון נהג'],
      ['fuel_type', 'דלק', (v) => FUEL[v] || v], ['amount_text', 'כמות מבוקשת'], ['status', 'סטטוס', (v) => STATUS[v]],
      ['deny_text', 'סיבת חסימה'], ['approval_no', 'מספר אישור'], ['approver_name', 'מאשר'], ['approver_phone', 'טלפון מאשר'],
      ['decided_at', 'זמן החלטה', fmtDateTime], ['approved_text', 'כמות מאושרת'], ['approver_note', 'הערת מאשר'],
      ['reconcile_status', 'בקרה', (v) => RECONCILE[v] || ''], ['voucher_no', 'מס׳ שובר'], ['actual_amount', 'כמות בפועל'],
      ['reconciled_by_name', 'נבדק ע״י'], ['reconciled_at', 'זמן בדיקה', fmtDateTime], ['reconcile_note', 'הערת בקרה'],
    ];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => esc(c[1])).join(',')];
    for (const r of rows) lines.push(cols.map(([k, , f]) => esc(f ? f(r[k]) : r[k])).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `תדלוקים_${monitorState.from}_${monitorState.to}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function openRequest(id) {
    let d;
    try {
      d = await call('request.detail', { id });
    } catch (e) {
      return toast(e.message, true);
    }
    const r = d.request;
    const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter((p) => p[1] !== null && p[1] !== undefined && p[1] !== '').map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    const parts = [
      h('div', { style: 'margin:10px 0' }, pill(r.status), ' ', r.status === 'approved' ? pill(r.reconcile_status || 'todo') : ''),
      kv([
        ['רכב', h('span', { class: 'num' }, r.plate_fmt)], ['תיאור', r.vehicle_desc], ['לקוח', r.company_name],
        ['נהג', `${r.driver_name} · ${fmtPhone(r.driver_phone)}`], ['תחנה', r.station_name + (r.pump ? ` · משאבה ${r.pump}` : '')],
        ['כמות מבוקשת', r.amount_text + (r.over_limit ? ' (מעל המכסה)' : '')], ['קילומטראז׳', r.odometer], ['הערות', r.notes],
        ['נוצרה', fmtDateTime(r.created_at)], ['סיבת חסימה', r.deny_text],
      ]),
    ];
    if (r.decided_at && ['approved', 'rejected'].includes(r.status)) {
      parts.push(h('h3', { style: 'margin-top:16px' }, 'החלטה'), kv([
        ['מאשר', `${r.approver_name} · ${fmtPhone(r.approver_phone)}`], ['זמן', fmtDateTime(r.decided_at)],
        ['מספר אישור', r.approval_no && h('span', { class: 'num' }, r.approval_no)],
        ['קוד חד-פעמי שהוזן', r.approval_code && h('span', { class: 'num' }, r.approval_code)],
        ['כמות מאושרת', r.approved_text], ['הערה', r.approver_note], ['IP', r.approver_ip],
      ]));
    }
    if (r.reconcile_status) {
      parts.push(h('h3', { style: 'margin-top:16px' }, 'בקרת שובר'), kv([
        ['תוצאה', RECONCILE[r.reconcile_status]], ['מס׳ שובר', r.voucher_no], ['כמות בפועל', r.actual_amount],
        ['נבדק ע״י', r.reconciled_by_name], ['זמן', fmtDateTime(r.reconciled_at)], ['הערה', r.reconcile_note],
      ]));
    }
    if (d.approvers.length) {
      parts.push(h('h3', { style: 'margin-top:16px' }, 'מאשרים שקיבלו הודעה'),
        h('ul', { class: 'timeline' }, d.approvers.map((a) => h('li', null,
          `${a.approver_name} (${fmtPhone(a.approver_phone)}) - SMS ${a.sms_status === 'sent' ? 'נשלח' : 'נכשל'}`,
          a.viewed_at ? ` · צפה ${fmtTime(a.viewed_at)}` : ' · לא צפה',
          a.attempts ? ` · ${a.attempts} קודים שגויים` : '',
          a.decision ? ` · ${a.decision === 'approve' ? 'אישר' : 'דחה'}` : ''))));
    }
    if (d.log.length) {
      parts.push(h('h3', { style: 'margin-top:16px' }, 'יומן'), h('ul', { class: 'timeline' }, d.log.map((l) => h('li', null,
        h('span', { class: 't' }, fmtDateTime(l.created_at)), EVENT[l.event] || l.event, l.actor_name ? ` · ${l.actor_name}` : '',
        l.ip ? h('span', { class: 'muted small' }, ` · ${l.ip}`) : ''))));
    }
    let footer = null;
    if (me.role !== 'station' && r.status === 'approved' && !r.reconcile_status) {
      footer = h('button', { class: 'primary', type: 'button', onclick: () => reconcileDialog(r) }, 'בקרת שובר');
    } else if (me.role === 'admin' && r.reconcile_status) {
      footer = h('button', { type: 'button', onclick: async () => {
        const reason = prompt('סיבה לביטול סימון הבקרה (נרשם ביומן):');
        if (!reason) return;
        try {
          await call('reconcile.undo', { id: r.id, reason });
          toast('הסימון בוטל');
          openRequest(r.id);
        } catch (e) { toast(e.message, true); }
      } }, 'ביטול סימון בקרה');
    }
    openDialog(`בקשה #${r.request_no}`, parts, footer);
  }

  const EVENT = {
    'request.created': 'בקשה נוצרה', 'request.denied': 'בקשה נחסמה', 'sms.sent': 'SMS נשלח', 'sms.failed': 'SMS נכשל',
    'approval.viewed': 'המאשר פתח את הקישור', 'otp.failed': 'קוד שגוי', 'request.approved': 'אושר', 'request.rejected': 'נדחה',
    'request.expired': 'פג תוקף', 'request.cancelled': 'בוטל ע״י הנהג', 'request.reminded': 'תזכורת נשלחה',
    'reconcile.recorded': 'בקרה: נרשם ומאושר', 'reconcile.discrepancy': 'בקרה: חריגה', 'reconcile.undone': 'בקרה בוטלה',
    'auth.login': 'כניסה', 'auth.failed': 'כניסה נכשלה', 'auth.password_changed': 'סיסמה שונתה', 'admin.import': 'ייבוא רכבים',
    'admin.settings': 'הגדרות עודכנו',
  };

  // ---------- voucher control ----------

  function reconcileDialog(r) {
    const err = h('div', { class: 'error hidden', role: 'alert' });
    const voucher = h('input', { id: 'rcVoucher', required: true });
    const actual = h('input', { id: 'rcActual', type: 'number', inputmode: 'decimal', step: 'any', min: '0' });
    const note = h('textarea', { id: 'rcNote', maxlength: '300' });
    const submit = async (result) => {
      err.classList.add('hidden');
      try {
        await call('reconcile.mark', { id: r.id, voucherNo: voucher.value, actualAmount: actual.value, note: note.value, result });
        dlg.close();
        toast(result === 'recorded' ? 'סומן "נרשם ומאושר"' : 'סומן כחריגה');
        if (current === 'reconcile' || current === 'monitor') go(current);
      } catch (e) {
        err.textContent = e.message;
        err.classList.remove('hidden');
      }
    };
    openDialog(`בקרת שובר - אישור ${r.approval_no}`, [
      h('p', { class: 'muted small' }, 'השווה את פרטי השובר הידני לנתוני האישור. אם הכל תואם, סמן "נרשם ומאושר".'),
      h('dl', { class: 'kv' },
        h('dt', null, 'מספר אישור'), h('dd', { class: 'num' }, r.approval_no),
        h('dt', null, 'רכב'), h('dd', { class: 'num' }, r.plate_fmt),
        h('dt', null, 'לקוח'), h('dd', null, r.company_name),
        h('dt', null, 'מאשר'), h('dd', null, r.approver_name),
        h('dt', null, 'זמן אישור'), h('dd', { class: 'num' }, fmtDateTime(r.decided_at)),
        h('dt', null, 'כמות מאושרת'), h('dd', null, r.approved_text),
        h('dt', null, 'תחנה'), h('dd', null, r.station_name)),
      h('label', { for: 'rcVoucher' }, 'מספר שובר ידני'), voucher,
      h('label', { for: 'rcActual' }, 'כמות בפועל לפי השובר', h('span', { class: 'opt' }, ' (רשות)')), actual,
      h('label', { for: 'rcNote' }, 'הערה', h('span', { class: 'opt' }, ' (חובה בחריגה)')), note,
      err,
    ], [
      h('button', { class: 'ok', type: 'button', onclick: () => submit('recorded') }, '✓ נרשם ומאושר'),
      h('button', { class: 'bad', type: 'button', onclick: () => submit('discrepancy') }, 'חריגה'),
    ]);
    setTimeout(() => voucher.focus(), 50);
  }

  async function renderReconcile() {
    const err = h('div', { class: 'error hidden', role: 'alert' });
    const input = h('input', { id: 'rcFind', inputmode: 'numeric', maxlength: '7', class: 'code-input', style: 'font-size:1.6rem', autocomplete: 'off' });
    const form = h('form', { class: 'card', style: 'max-width:520px' },
      h('h2', null, 'בדיקת שובר לפי מספר אישור'),
      h('label', { for: 'rcFind' }, 'מספר האישור שנרשם על השובר (7 ספרות)'), input, err,
      h('button', { class: 'primary block', type: 'submit' }, 'חיפוש'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        const r = await call('reconcile.find', { approvalNo: input.value });
        if (r.status !== 'approved') throw new Error(`האישור במצב "${STATUS[r.status]}" ולא ניתן לסמן אותו`);
        if (r.reconcile_status) return openRequest(r.id);
        reconcileDialog(r);
        input.value = '';
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });
    const listWrap = h('div', { class: 'table-wrap' }, h('p', { class: 'muted', style: 'padding:14px' }, 'טוען…'));
    pane.replaceChildren(form, h('h2', null, 'אישורים שטרם נבדק להם שובר (60 יום אחרונים)'), listWrap);
    input.focus();
    try {
      const rows = await call('monitor.list', { status: 'unreconciled', from: dayStart(addDays(todayStr(), -60)) });
      listWrap.replaceChildren(requestsTable(rows));
    } catch (e) {
      listWrap.replaceChildren(h('div', { class: 'error' }, e.message));
    }
  }

  // ---------- admin tables ----------

  const bool = (v) => (v ? 'כן' : 'לא');
  const companyName = (id) => lookups.companies.find((c) => c.id === id)?.name || '';
  const stationName = (id) => lookups.stations.find((s) => s.id === id)?.name || '';
  const companyActive = (id) => lookups.companies.find((c) => c.id === id)?.active !== false;
  // A vehicle/approver of an inactive company is blocked too, so it counts as hidden.
  const isActive = (r) => r.active !== false && (!('company_id' in r) || companyActive(r.company_id));
  const activeText = (v, r) => (r.active === false ? 'לא' : companyActive(r.company_id) ? 'כן' : 'לא (הלקוח לא פעיל)');
  const showFilter = {}; // per table: 'active' | 'hidden' | 'all'

  const SCHEMAS = {
    vehicles: {
      title: 'רכב',
      cols: [['plate', 'מספר רכב', fmtPlate], ['company_id', 'לקוח', companyName], ['description', 'תיאור'],
        ['fuel_type', 'דלק', (v) => FUEL[v] || ''], ['max_liters', 'מכסה (ל׳)'],
        ['approver_ids', 'מאשרים', (v, r) => (v?.length ? v.map((id) => lookups.approvers.find((a) => a.id === id)?.name).join(', ') : 'כל מאשרי הלקוח')],
        ['active', 'פעיל', activeText]],
      fields: [
        { k: 'plate', l: 'מספר רכב', req: true, attrs: { inputmode: 'numeric' } },
        { k: 'company_id', l: 'לקוח', type: 'company', req: true },
        { k: 'description', l: 'תיאור (דגם / סוג)' },
        { k: 'fuel_type', l: 'סוג דלק', type: 'select', options: { '': '-', ...FUEL } },
        { k: 'max_liters', l: 'מכסת ליטרים לתדלוק', type: 'number', hint: 'בקשה מעל המכסה מסומנת למאשר' },
        { k: 'approver_ids', l: 'מאשרים לרכב זה', type: 'approvers', hint: 'לא סומן אף אחד = כל מאשרי הלקוח שמוגדרים "מאשר לכל הרכבים"' },
        { k: 'notes', l: 'הערות', type: 'textarea' },
        { k: 'active', l: 'פעיל (מורשה לתדלוק)', type: 'bool', hint: 'רכבים לא נמחקים מהמערכת. כדי להסיר רכב מבטלים את הסימון: הרכב מוסתר מהרשימה ונחסם לתדלוק, וההיסטוריה שלו נשמרת.' },
      ],
      search: (r) => [r.plate, r.description, companyName(r.company_id)].join(' '),
      extra: () => importButton(),
    },
    approvers: {
      title: 'מאשר',
      cols: [['name', 'שם'], ['phone', 'טלפון', fmtPhone], ['company_id', 'לקוח', companyName], ['role_title', 'תפקיד'],
        ['all_vehicles', 'לכל הרכבים', bool], ['active', 'פעיל', activeText]],
      fields: [
        { k: 'name', l: 'שם', req: true },
        { k: 'phone', l: 'טלפון נייד (יקבל SMS)', req: true, attrs: { type: 'tel', inputmode: 'tel', dir: 'ltr' } },
        { k: 'company_id', l: 'לקוח', type: 'company', req: true },
        { k: 'role_title', l: 'תפקיד' },
        { k: 'all_vehicles', l: 'מאשר לכל רכבי הלקוח (שאין להם מאשר ייעודי)', type: 'bool' },
        { k: 'active', l: 'פעיל', type: 'bool' },
      ],
      search: (r) => [r.name, r.phone, companyName(r.company_id)].join(' '),
    },
    companies: {
      title: 'לקוח',
      cols: [['name', 'שם'], ['tax_id', 'ח.פ.'], ['contact_name', 'איש קשר'], ['contact_phone', 'טלפון'],
        ['station_ids', 'תחנות מורשות', (v, r) => (r.all_stations !== false ? 'כל התחנות' : (v || []).map(stationName).join(', ') || '-')],
        ['active', 'פעיל', bool]],
      fields: [
        { k: 'name', l: 'שם הלקוח', req: true }, { k: 'tax_id', l: 'ח.פ.' }, { k: 'contact_name', l: 'איש קשר' },
        { k: 'contact_phone', l: 'טלפון' },
        { k: 'station_ids', l: 'תחנות שבהן מותר לתדלק', type: 'stations', req: true, hint: 'חובה: "כל התחנות" או לפחות תחנה אחת. בתחנה שלא סומנה הנהג יקבל "תחנה לא מורשית" ורשימת התחנות המורשות.' },
        { k: 'notes', l: 'הערות', type: 'textarea' },
        { k: 'active', l: 'פעיל', type: 'bool', hint: 'ביטול הסימון מסתיר את הלקוח, את הרכבים ואת המאשרים שלו, וחוסם תדלוק לכל רכביו.' },
      ],
      search: (r) => [r.name, r.tax_id].join(' '),
    },
    stations: {
      title: 'תחנה', fem: true,
      cols: [['name', 'שם'], ['code', 'קוד'], ['address', 'כתובת'], ['active', 'פעילה', bool]],
      fields: [
        { k: 'name', l: 'שם התחנה', req: true },
        { k: 'code', l: 'קוד (באנגלית, מופיע בקישור ה-QR)', hint: 'ריק = ייווצר אוטומטית', attrs: { dir: 'ltr' } },
        { k: 'address', l: 'כתובת' }, { k: 'active', l: 'פעילה', type: 'bool' },
      ],
      rowAction: (r) => h('button', { type: 'button', onclick: (e) => { e.stopPropagation(); showQr(r); } }, 'QR להדפסה'),
    },
    users: {
      title: 'משתמש',
      cols: [['username', 'שם משתמש'], ['name', 'שם'], ['role', 'תפקיד', (v) => ROLES[v]], ['station_id', 'תחנה', stationName], ['active', 'פעיל', bool]],
      fields: [
        { k: 'username', l: 'שם משתמש', req: true, attrs: { dir: 'ltr', autocomplete: 'off' } },
        { k: 'name', l: 'שם מלא', req: true },
        { k: 'role', l: 'תפקיד', type: 'select', options: { '': '-', ...ROLES }, req: true },
        { k: 'station_id', l: 'תחנה (לעמדת תחנה)', type: 'station' },
        { k: 'password', l: 'סיסמה', attrs: { type: 'password', autocomplete: 'new-password', dir: 'ltr' }, hint: 'לפחות 8 תווים. בעריכה - ריק = ללא שינוי' },
        { k: 'active', l: 'פעיל', type: 'bool' },
      ],
    },
  };

  async function renderTable(table) {
    const S = SCHEMAS[table];
    let rows;
    try {
      rows = await call('admin.list', { table });
      lookups = await call('admin.lookups');
    } catch (e) {
      pane.replaceChildren(h('div', { class: 'error' }, e.message));
      return;
    }
    const q = h('input', { type: 'search', placeholder: 'חיפוש…', 'aria-label': 'חיפוש' });
    const wrap = h('div', { class: 'table-wrap' });
    const nActive = rows.filter(isActive).length;
    const shown = h('select', { 'aria-label': 'הצגה' },
      h('option', { value: 'active' }, `פעילים (${nActive})`),
      h('option', { value: 'hidden' }, `לא פעילים / מוסתרים (${rows.length - nActive})`),
      h('option', { value: 'all' }, `הכל (${rows.length})`));
    shown.value = showFilter[table] || 'active';
    shown.addEventListener('change', () => { showFilter[table] = shown.value; draw(); });
    const draw = () => {
      const term = q.value.trim().replace(/-/g, '');
      const byState = rows.filter((r) => shown.value === 'all' || (shown.value === 'active') === isActive(r));
      const list = term && S.search ? byState.filter((r) => S.search(r).replace(/-/g, '').includes(term)) : byState;
      wrap.replaceChildren(list.length ? h('table', null,
        h('thead', null, h('tr', null, S.cols.map((c) => h('th', null, c[1])), S.rowAction ? h('th') : null)),
        h('tbody', null, list.map((r) => h('tr', { class: 'click' + (isActive(r) ? '' : ' inactive'), tabindex: '0', onclick: () => editRow(table, r), onkeydown: (e) => e.key === 'Enter' && editRow(table, r) },
          S.cols.map(([k, , f]) => h('td', { class: ['plate', 'phone', 'code', 'max_liters'].includes(k) ? 'num' : null }, f ? f(r[k], r) : r[k] ?? '')),
          S.rowAction ? h('td', null, S.rowAction(r)) : null))))
        : h('p', { class: 'muted', style: 'padding:14px' }, shown.value === 'hidden' ? 'אין רשומות לא פעילות.' : 'אין רשומות.'));
    };
    q.addEventListener('input', draw);
    pane.replaceChildren(
      h('div', { class: 'toolbar' },
        h('button', { class: 'primary', type: 'button', onclick: () => editRow(table, { active: true, all_vehicles: true }) }, `+ ${S.title} ${S.fem ? 'חדשה' : 'חדש'}`),
        shown, S.search ? q : null, S.extra ? S.extra() : null),
      wrap);
    draw();
  }

  function editRow(table, row) {
    const S = SCHEMAS[table];
    const err = h('div', { class: 'error hidden', role: 'alert' });
    const inputs = {};
    const approverBox = h('div');
    // company: "all stations" switch + per-station checkboxes (hidden while "all" is on)
    const allStations = h('input', { type: 'checkbox', checked: row.id ? row.all_stations !== false : false });
    const stationList = h('div', { style: 'margin-inline-start:28px' },
      lookups.stations.filter((st) => st.active || (row.station_ids || []).includes(st.id)).map((st) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', value: st.id, checked: (row.station_ids || []).includes(st.id) }),
        st.name + (st.active ? '' : ' (לא פעילה)'))));
    const stationBox = h('div', { role: 'group' }, h('label', { class: 'check' }, allStations, h('b', null, 'כל התחנות')), stationList);
    const syncStations = () => stationList.classList.toggle('hidden', allStations.checked);
    allStations.addEventListener('change', syncStations);
    syncStations();
    const nodes = [];
    for (const f of S.fields) {
      const id = 'f_' + f.k;
      let el;
      if (f.type === 'bool') {
        el = h('input', { type: 'checkbox', id, checked: row[f.k] !== false });
        nodes.push(h('label', { class: 'check' }, el, f.l));
      } else {
        if (f.type === 'select' || f.type === 'company' || f.type === 'station') {
          const opts = f.type === 'company' ? { '': 'בחר לקוח…', ...Object.fromEntries(lookups.companies.filter((c) => c.active || c.id === row[f.k]).map((c) => [c.id, c.name + (c.active ? '' : ' (לא פעיל)')])) }
            : f.type === 'station' ? { '': '-', ...Object.fromEntries(lookups.stations.map((s) => [s.id, s.name])) } : f.options;
          el = h('select', { id }, Object.entries(opts).map(([k, v]) => h('option', { value: k }, v)));
          el.value = row[f.k] ?? '';
        } else if (f.type === 'approvers') {
          el = approverBox;
        } else if (f.type === 'stations') {
          el = stationBox;
        } else if (f.type === 'textarea') {
          el = h('textarea', { id });
          el.value = row[f.k] ?? '';
        } else {
          el = h('input', { id, type: f.type === 'number' ? 'number' : 'text', ...(f.attrs || {}) });
          el.value = f.k === 'plate' ? fmtPlate(row[f.k]) : row[f.k] ?? '';
        }
        nodes.push(h('label', { for: id }, f.l, f.req ? '' : h('span', { class: 'opt' }, ' (רשות)')), el);
        if (f.hint) nodes.push(h('div', { class: 'muted small' }, f.hint));
      }
      inputs[f.k] = el;
    }
    // vehicle: approver checkboxes follow the chosen company
    const drawApprovers = () => {
      const cid = inputs.company_id?.value;
      const list = lookups.approvers.filter((a) => a.company_id === cid && (a.active || (row.approver_ids || []).includes(a.id)));
      approverBox.replaceChildren(...(list.length ? list.map((a) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', value: a.id, checked: (row.approver_ids || []).includes(a.id) }), a.name + (a.active ? '' : ' (לא פעיל)')))
        : [h('div', { class: 'muted small' }, cid ? 'ללקוח זה אין מאשרים עדיין' : 'בחר לקוח')]));
    };
    if (table === 'vehicles') {
      drawApprovers();
      inputs.company_id.addEventListener('change', drawApprovers);
    }

    const save = async () => {
      err.classList.add('hidden');
      const out = { id: row.id };
      for (const f of S.fields) {
        const el = inputs[f.k];
        if (f.type === 'bool') out[f.k] = el.checked;
        else if (f.type === 'approvers') out[f.k] = [...approverBox.querySelectorAll('input:checked')].map((i) => i.value);
        else if (f.type === 'stations') {
          out.all_stations = allStations.checked;
          out[f.k] = allStations.checked ? [] : [...stationList.querySelectorAll('input:checked')].map((i) => i.value);
        }
        else out[f.k] = el.value;
      }
      try {
        await call('admin.save', { table, row: out });
        dlg.close();
        toast('נשמר');
        renderTable(table);
      } catch (e) {
        err.textContent = e.message;
        err.classList.remove('hidden');
      }
    };
    openDialog(row.id ? `עריכת ${S.title}` : `${S.title} ${S.fem ? 'חדשה' : 'חדש'}`, [...nodes, err],
      [h('button', { class: 'primary', type: 'button', onclick: save }, 'שמירה'), h('button', { type: 'button', onclick: () => dlg.close() }, 'ביטול')]);
  }

  // ---------- vehicle import ----------

  const IMPORT_COLS = {
    plate: ['מספר רכב', 'רכב', 'מס רכב', 'מספר רישוי', 'plate'],
    company: ['לקוח', 'שם לקוח', 'חברה', 'שם חברה', 'company'],
    description: ['תיאור', 'דגם', 'סוג רכב', 'description'],
    fuel_type: ['סוג דלק', 'דלק', 'fuel'],
    max_liters: ['מכסה', 'מכסת ליטרים', 'ליטרים', 'max_liters'],
    approver_name: ['שם מאשר', 'מאשר', 'approver'],
    approver_phone: ['טלפון מאשר', 'נייד מאשר', 'approver_phone'],
  };

  function importButton() {
    const file = h('input', { type: 'file', accept: '.xlsx,.xls,.csv', class: 'hidden' });
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      if (!window.XLSX) return toast('רכיב קריאת האקסל לא נטען - בדוק חיבור לאינטרנט', true);
      const wb = XLSX.read(await f.arrayBuffer());
      const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
      const norm = (s) => String(s).replace(/["'׳״]/g, '').trim().toLowerCase();
      const rows = raw.map((r) => {
        const out = {};
        for (const [k, names] of Object.entries(IMPORT_COLS)) {
          const key = Object.keys(r).find((c) => names.map(norm).includes(norm(c)));
          if (key) out[k] = r[key];
        }
        return out;
      }).filter((r) => r.plate || r.company);
      if (!rows.length) return toast('לא נמצאו עמודות "מספר רכב" ו"לקוח" בשורה הראשונה', true);
      if (!confirm(`לייבא ${rows.length} שורות? רכבים קיימים (לפי מספר) יעודכנו.`)) return;
      try {
        const r = await call('admin.importVehicles', { rows });
        const msg = `נוספו ${r.vehicles_new} רכבים, עודכנו ${r.vehicles_updated}, לקוחות חדשים ${r.companies}, מאשרים חדשים ${r.approvers}`;
        openDialog('תוצאות ייבוא', [h('p', null, msg),
          r.errors.length ? [h('h3', null, `${r.errors.length} שורות לא יובאו`), h('ul', null, r.errors.slice(0, 200).map((e) => h('li', null, `שורה ${e.line}: ${e.error}`)))] : null]);
        renderTable('vehicles');
      } catch (e) {
        toast(e.message, true);
      }
    });
    const template = () => {
      const csv = '﻿מספר רכב,לקוח,תיאור,סוג דלק,מכסה,שם מאשר,טלפון מאשר\r\n12-345-67,הובלות לדוגמה בע"מ,טנדר,סולר,80,ישראל ישראלי,0501234567\r\n';
      const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })), download: 'תבנית_ייבוא_רכבים.csv' });
      document.body.append(a);
      a.click();
      a.remove();
    };
    return h('span', { style: 'display:inline-flex;gap:8px' },
      h('button', { type: 'button', onclick: () => file.click() }, 'ייבוא מאקסל'),
      h('button', { type: 'button', class: 'link', onclick: template }, 'תבנית לדוגמה'), file);
  }

  // ---------- station QR ----------

  async function showQr(st) {
    let base = location.origin + location.pathname.replace(/[^/]*$/, '');
    try {
      const s = (await call('settings.get')).settings;
      if (s.public_url) base = s.public_url.replace(/\/+$/, '') + '/';
    } catch {}
    const url = `${base}request.html?s=${encodeURIComponent(st.code)}`;
    const box = h('div', { style: 'display:flex;justify-content:center;margin:16px 0' });
    const sheet = h('div', { id: 'qrSheet', style: 'text-align:center' },
      h('h1', { style: 'font-size:2rem' }, 'אין דלקן בתחנה?'),
      h('p', { style: 'font-size:1.3rem;margin:0' }, 'נהגים של לקוחות מורשים - סרקו לבקשת אישור תדלוק'),
      box,
      h('p', { style: 'font-weight:700;font-size:1.2rem' }, st.name),
      h('p', { class: 'small num', style: 'word-break:break-all' }, url));
    openDialog('QR לתחנה', sheet, [
      h('button', { class: 'primary', type: 'button', onclick: () => printQr(sheet) }, 'הדפסה'),
      h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'פתיחת הטופס')]);
    if (window.QRCode) new QRCode(box, { text: url, width: 260, height: 260, correctLevel: QRCode.CorrectLevel.M });
    else box.textContent = 'רכיב ה-QR לא נטען - בדוק חיבור לאינטרנט';
  }

  function printQr(sheet) {
    const w = window.open('', '_blank');
    if (!w) return toast('הדפדפן חסם חלון קופץ', true);
    const img = sheet.querySelector('img')?.src || sheet.querySelector('canvas')?.toDataURL();
    const clone = sheet.cloneNode(true);
    const holder = clone.querySelector('div');
    holder.replaceChildren();
    if (img) holder.append(Object.assign(document.createElement('img'), { src: img, style: 'width:9cm;height:9cm' }));
    w.document.write(`<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>QR</title>
      <style>body{font-family:Heebo,Arial,sans-serif;display:flex;justify-content:center;padding:2cm}div{display:flex;justify-content:center}</style></head>
      <body>${clone.outerHTML}<script>onload=()=>{print()}<\/script></body></html>`);
    w.document.close();
  }

  // ---------- audit / outbox / settings ----------

  async function renderAudit() {
    const from = h('input', { type: 'date', id: 'aFrom', value: addDays(todayStr(), -7) });
    const to = h('input', { type: 'date', id: 'aTo', value: todayStr() });
    const ev = h('select', { id: 'aEv' }, h('option', { value: '' }, 'כל האירועים'),
      [['request.', 'בקשות'], ['otp.', 'קודים שגויים'], ['sms.', 'SMS'], ['reconcile.', 'בקרת שוברים'], ['auth.', 'כניסות'], ['admin.', 'שינויי ניהול']]
        .map(([v, l]) => h('option', { value: v }, l)));
    const wrap = h('div', { class: 'table-wrap' });
    const load = async () => {
      try {
        const rows = await call('audit.list', { from: dayStart(from.value), to: dayStart(addDays(to.value, 1)), event: ev.value || null });
        wrap.replaceChildren(rows.length ? h('table', null,
          h('thead', null, h('tr', null, ['זמן', 'אירוע', 'מבצע', 'פרטים', 'IP'].map((t) => h('th', null, t)))),
          h('tbody', null, rows.map((l) => h('tr', { class: l.request_id ? 'click' : null, onclick: l.request_id ? () => openRequest(l.request_id) : null },
            h('td', { class: 'num' }, fmtDateTime(l.created_at)),
            h('td', null, EVENT[l.event] || l.event),
            h('td', null, l.actor_name || l.actor_type || ''),
            h('td', { class: 'small' }, l.details ? detailsText(l.details) : ''),
            h('td', { class: 'num small' }, l.ip || ''))))) : h('p', { class: 'muted', style: 'padding:14px' }, 'אין אירועים.'));
      } catch (e) {
        wrap.replaceChildren(h('div', { class: 'error' }, e.message));
      }
    };
    [from, to, ev].forEach((x) => x.addEventListener('change', load));
    const lbl = (t, el) => h('div', null, h('label', { for: el.id }, t), el);
    pane.replaceChildren(h('div', { class: 'toolbar' }, lbl('מתאריך', from), lbl('עד', to), lbl('סוג', ev)),
      h('p', { class: 'muted small' }, 'היומן אינו ניתן לעריכה או מחיקה. לחיצה על שורה של בקשה פותחת אותה.'), wrap);
    load();
  }

  function detailsText(d) {
    return Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ').slice(0, 300);
  }

  async function renderOutbox() {
    let rows;
    try {
      rows = await call('outbox.list');
    } catch (e) {
      pane.replaceChildren(h('div', { class: 'error' }, e.message));
      return;
    }
    pane.replaceChildren(
      h('p', { class: 'muted small' }, App.smsProvider === 'demo'
        ? 'מצב הדגמה: ההודעות לא נשלחו באמת. כדי לנסות, העתק את הקוד ופתח את הקישור מההודעה.'
        : 'בהודעות שנשלחו באמת הקוד מוסתר (******), כך שגם מנהל המערכת לא יכול לאשר במקום המאשר.'),
      h('button', { type: 'button', onclick: renderOutbox, style: 'margin-bottom:10px' }, 'רענון'),
      h('div', { class: 'table-wrap' }, rows.length ? h('table', null,
        h('thead', null, h('tr', null, ['זמן', 'אל', 'הודעה', 'סטטוס'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((m) => h('tr', null,
          h('td', { class: 'num' }, fmtDateTime(m.created_at)),
          h('td', { class: 'num' }, fmtPhone(m.to_phone)),
          h('td', { style: 'white-space:pre-wrap' }, linkify(m.body)),
          h('td', null, m.status === 'sent' ? 'נשלח' : `נכשל: ${m.error || ''}`)))))
        : h('p', { class: 'muted', style: 'padding:14px' }, 'אין הודעות.')));
  }

  function linkify(text) {
    return String(text).split(/(https?:\/\/\S+)/).map((p) => (/^https?:\/\//.test(p) ? h('a', { href: p, target: '_blank', rel: 'noopener', dir: 'ltr' }, 'פתיחת הקישור') : p));
  }

  // a top tab with its own row of sub-tabs
  function renderGroup(group) {
    const nav = h('nav', { class: 'tabs subtabs no-print', role: 'tablist' });
    const sub = h('div');
    const open = (id) => {
      groupSub[group] = id;
      history.replaceState(null, '', `#${group}/${id}`);
      nav.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.dataset.sub === id);
        b.setAttribute('aria-selected', b.dataset.sub === id);
      });
      pane = sub;
      sub.replaceChildren(h('div', { class: 'muted' }, 'טוען…'));
      GROUPS[group].find((t) => t.id === id).render();
    };
    for (const t of GROUPS[group]) nav.append(h('button', { type: 'button', role: 'tab', 'data-sub': t.id, onclick: () => open(t.id) }, t.label));
    body.replaceChildren(nav, sub);
    open(groupSub[group]);
  }

  async function renderGeneral() {
    let s;
    try {
      s = await call('settings.get');
    } catch (e) {
      pane.replaceChildren(h('div', { class: 'error' }, e.message));
      return;
    }
    const F = [
      ['org_name', 'שם המערכת (מוצג לנהגים)', 'text'],
      ['public_url', 'כתובת האתר לקישורים ב-SMS', 'url', 'לדוגמה https://fuel.example.co.il - ריק = הכתובת שהוגדרה בשרת'],
      ['request_minutes', 'תוקף בקשה ממתינה (דקות)', 'number'],
      ['otp_max_attempts', 'מספר ניסיונות קוד שגוי לפני נעילה', 'number'],
      ['max_requests_per_phone_hour', 'מקסימום בקשות לטלפון בשעה', 'number'],
      ['reminder_after_minutes', 'דקות עד שהנהג יכול לשלוח תזכורת', 'number'],
      ['max_reminders', 'מקסימום תזכורות לבקשה', 'number'],
      ['notify_driver_sms', 'לשלוח לנהג SMS עם התשובה (עולה הודעה נוספת)', 'bool'],
    ];
    const inputs = {};
    const err = h('div', { class: 'error hidden', role: 'alert' });
    const nodes = F.map(([k, l, t, hint]) => {
      if (t === 'bool') {
        inputs[k] = h('input', { type: 'checkbox', id: 's_' + k, checked: !!s.settings[k] });
        return h('label', { class: 'check' }, inputs[k], l);
      }
      inputs[k] = h('input', { id: 's_' + k, type: t === 'number' ? 'number' : 'text', value: s.settings[k] ?? '', dir: t === 'url' ? 'ltr' : null });
      return [h('label', { for: 's_' + k }, l), inputs[k], hint ? h('div', { class: 'muted small' }, hint) : null];
    });
    const pw = {
      old: h('input', { type: 'password', id: 'pwOld', autocomplete: 'current-password', dir: 'ltr' }),
      new: h('input', { type: 'password', id: 'pwNew', autocomplete: 'new-password', dir: 'ltr' }),
    };
    pane.replaceChildren(
      h('div', { class: 'card', style: 'max-width:560px' }, h('h2', null, 'הגדרות'),
        h('p', { class: 'muted small' }, `ספק SMS: ${s.sms_provider === 'demo' ? 'הדגמה (לא נשלח באמת)' : s.sms_provider}. הספק מוגדר בשרת (משתני סביבה).`),
        nodes, err,
        h('button', { class: 'primary block', type: 'button', onclick: async () => {
          err.classList.add('hidden');
          const out = {};
          for (const [k, , t] of F) out[k] = t === 'bool' ? inputs[k].checked : inputs[k].value;
          try {
            await call('settings.save', { settings: out });
            toast('ההגדרות נשמרו');
          } catch (e) {
            err.textContent = e.message;
            err.classList.remove('hidden');
          }
        } }, 'שמירה')),
      h('div', { class: 'card', style: 'max-width:560px' }, h('h2', null, 'החלפת סיסמה'),
        h('label', { for: 'pwOld' }, 'סיסמה נוכחית'), pw.old, h('label', { for: 'pwNew' }, 'סיסמה חדשה (8+ תווים)'), pw.new,
        h('button', { class: 'block', type: 'button', onclick: async () => {
          try {
            await call('auth.changePassword', { oldPassword: pw.old.value, newPassword: pw.new.value });
            pw.old.value = pw.new.value = '';
            toast('הסיסמה הוחלפה');
          } catch (e) { toast(e.message, true); }
        } }, 'החלפה')));
  }

  boot();
})();
