/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  /* WIRED: Xero (October 2026). Read-only: offline_access +
     accounting.reports.profitandloss.read. P&L, accrual basis, standard layout. */
  accounting: {
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      /* + accounting.settings.read (read-only) to look up the 'Department'
         tracking category, so wages can be split by department (8 Oct 2026). */
      scopes: 'offline_access accounting.reports.profitandloss.read accounting.settings.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'
    },
    async status(env, h) {
      const t = await h.getTokens();
      if (!t || !t.access_token) return { connected: false };
      const tenant = await xeroTenant(env, h);
      return {
        connected: true,
        org: tenant.name,
        sandbox: /demo company/i.test(tenant.name || '')
      };
    },
    async fetchRange(env, h, q) {
      const rep = await xeroPnl(env, h, { fromDate: q.from, toDate: q.to }, 120);
      const f = xeroColumns(rep, 1)[0].figures;
      applyDeptWages(f, await xeroDeptPnl(env, h, { fromDate: q.from, toDate: q.to }, 120));
      try { applyStockGate(f, monthsInRange(q.from, q.to), await stocktakeStatus(env, h)); } catch (e) {}
      return f;
    },
    async fetchMonthly(env, h, q) {
      /* Xero returns up to 12 monthly columns per call (newest first); chunk. */
      const months = monthList(q.fromMonth, q.toMonth);
      const FIELDS = ['revenue', 'cogs', 'wagesSuper', 'overheads', 'gamingRevenue'].concat(centreKeys());
      const out = { months: [] };
      FIELDS.forEach((k) => { out[k] = []; });
      const byMonth = {};
      for (let end = months.length; end > 0; end -= 12) {
        const start = Math.max(0, end - 12);
        const n = end - start;
        const last = months[end - 1];
        const [ly, lm] = last.split('-').map(Number);
        const lastDay = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
        const params = { fromDate: last + '-01', toDate: last + '-' + String(lastDay).padStart(2, '0') };
        if (n > 1) { params.periods = String(n - 1); params.timeframe = 'MONTH'; }
        const rep = await xeroPnl(env, h, params, 3600);
        const cols = xeroColumns(rep, n);
        for (let i = 0; i < n; i++) byMonth[months[end - 1 - i]] = cols[i] ? cols[i].figures : null;
      }
      /* Department split per month (last 13 months; one report per month,
         cached a day for closed months, an hour for the current one). */
      const nowMo = new Date().toISOString().slice(0, 7);
      for (const mo of months.slice(-13)) {
        if (!byMonth[mo]) continue;
        const [y, m] = mo.split('-').map(Number);
        const ld = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const d = await xeroDeptPnl(env, h, { fromDate: mo + '-01', toDate: mo + '-' + String(ld).padStart(2, '0') }, mo < nowMo ? 86400 : 3600);
        if (d.unavailable) break;
        applyDeptWages(byMonth[mo], d);
      }
      try { const st = await stocktakeStatus(env, h); months.forEach((mo) => applyStockGate(byMonth[mo], [mo], st)); } catch (e) {}
      months.forEach((mo) => {
        const f = byMonth[mo];
        out.months.push(mo);
        FIELDS.forEach((k) => out[k].push(f && f[k] !== undefined ? f[k] : null));
      });
      return out;
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('pos'); },
    async fetchMonthly(env, h, q) { throw new NotConfigured('pos'); }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    configured: false,
    auth: null,
    oauth: {},
    async status(env, h) { return { connected: false }; },
    async fetchRange(env, h, q) { throw new NotConfigured('rostering'); },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }
};

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

/* ---------------- Xero helpers (accounting adapter) ----------------
   Wage/super lines are proposed by keyword and CONFIRMED WITH THE OWNER at
   reconciliation (kpi-spec.md, metric 5). Once confirmed, list the exact
   account names in WAGE_ACCOUNTS_CONFIRMED and that list wins over keywords. */
const WAGE_RE = /\b(wages?|salar(y|ies)|superannuation|super|payroll|annual leave|long service|workcover|workers'? comp(ensation)?)\b/i;
const WAGE_ACCOUNTS_CONFIRMED = null; /* e.g. ['Wages and Salaries', 'Superannuation'] */
/* Owner decision (7 Oct 2026): the owners' pay ("Johnson Wages", "Johnson
   Superannuation") is NOT staff labour. It is kept out of Wage % and counted in
   Overheads, so Profit still matches the P&L. */
const WAGE_EXCLUDE_RE = /\bjohnson\b/i;
/* Owner's extra metric (7 Oct 2026): Wage % (excl. gaming) divides by revenue
   less these Income lines. Revenue itself is unchanged. */
const GAMING_RE = /\b(gaming|keno)\b/i; /* Gaming Machines + Keno income */
const COGS_RE = /\bcogs\b/i; /* owner's Cost of goods = lines named "COGS" */
function isWageLine(label) {
  if (WAGE_EXCLUDE_RE.test(label || '')) return false;
  if (Array.isArray(WAGE_ACCOUNTS_CONFIRMED)) {
    const l = String(label || '').trim().toLowerCase();
    return WAGE_ACCOUNTS_CONFIRMED.some((a) => a.trim().toLowerCase() === l);
  }
  return WAGE_RE.test(label || '');
}
function classifySection(title) {
  const t = String(title || '').toLowerCase();
  if (!t.trim()) return null;
  if (/other income/.test(t)) return 'otherIncome';
  if (/cost of sales|cost of goods|direct cost/.test(t)) return 'cogs';
  if (/income|revenue|sales/.test(t)) return 'revenue';
  if (/operating expenses|^(less )?expenses$|overheads/.test(t)) return 'opex';
  return 'excluded';
}
function toCents(v) {
  const s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[()]/g, ''));
  if (!isFinite(n)) return 0;
  return Math.round((neg ? -n : n) * 100);
}

async function xeroTenant(env, h) {
  const t = await h.getTokens();
  const cached = await env.TOKENS.get('xero:tenant');
  if (cached) {
    try { const c = JSON.parse(cached); if (c.stamp === t.obtained_at && c.id) return c; } catch (e) {}
  }
  const conns = await h.fetchJson('https://api.xero.com/connections', { headers: { Accept: 'application/json' } });
  const orgs = (Array.isArray(conns) ? conns : []).filter((c) => !c.tenantType || c.tenantType === 'ORGANISATION');
  if (!orgs.length) { const e = new Error('no organisation'); e.status = 403; throw e; }
  orgs.sort((a, b) => String(b.updatedDateUtc || b.createdDateUtc || '').localeCompare(String(a.updatedDateUtc || a.createdDateUtc || '')));
  const pick = { id: orgs[0].tenantId, name: orgs[0].tenantName, stamp: t.obtained_at, count: orgs.length };
  await env.TOKENS.put('xero:tenant', JSON.stringify(pick));
  return pick;
}

async function xeroPnl(env, h, params, ttl) {
  const tenant = await xeroTenant(env, h);
  const p = new URLSearchParams({ ...params, standardLayout: 'true', paymentsOnly: 'false' });
  const key = 'xero:pnl:' + tenant.id + ':' + p.toString();
  const hit = await env.TOKENS.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const data = await h.fetchJson('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + p.toString(), {
    headers: { 'xero-tenant-id': tenant.id, Accept: 'application/json' }
  });
  const rep = data && data.Reports && data.Reports[0];
  if (!rep) { const e = new Error('no report'); e.status = 500; throw e; }
  try { await env.TOKENS.put(key, JSON.stringify(rep), { expirationTtl: Math.max(60, ttl || 120) }); } catch (e) {}
  return rep;
}

/* Turn a P&L report into n columns (column 0 = first amount column, which for a
   multi-period report is the NEWEST month). Each column: { figures, lines }. */
/* ---------------- Cost centres (owner's management view, 8 Oct 2026) ----
   Exact Xero account names per cost centre, as given by the owner. Matching
   ignores case, extra spaces and dash style. Department wage accounts are not
   split in Xero yet: when they are, list them under `wages` and the tiles light
   up. F&B wages use ALL staff wages until then ('ALL_STAFF'). */
const CENTRES = {
  fb: {
    sales: ['Sales - Chard Bar', 'Sales - Chard Restaurant', 'Sales - Coffee Shop', 'Sales - Gaming Bar', 'Sales - Plantation Bar', 'Sales - Tapd', 'Sales - Tapd (Food)'],
    cogs: ['COGS - Chard Restaurant (Food)', 'COGS - Coffee Shop', 'COGS - Coffee Shop Cakes', 'COGS - Tapd', 'COGS - Tapd (Food)', 'Wastage'],
    wages: 'DEPT' /* Beverage + Restaurant departments */
  },
  kitchen: {
    sales: ['Sales - Chard Restaurant', 'Sales - Coffee Shop', 'Sales - Tapd (Food)'],
    /* Owner, 8 Oct 2026: kitchen COGS excludes COGS - Tapd (bar stock). */
    cogs: ['COGS - Chard Restaurant (Food)', 'COGS - Coffee Shop', 'COGS - Coffee Shop Cakes', 'COGS - Tapd (Food)', 'Wastage'],
    wages: 'DEPT' /* Kitchen department */
  },
  retail: {
    sales: ['Sales - Ripley DBS'],
    cogs: ['COGS - Ripley St'],
    wages: 'DEPT' /* Ripley DBS department */
  },
  bar: {
    sales: ['Sales - Chard Bar', 'Sales - Gaming Bar', 'Sales - Plantation Bar', 'Sales - Tapd'],
    cogs: ['COGS - Tapd'],
    wages: 'DEPT' /* Beverage department */
  },
  gaming: {
    sales: ['Gaming Machines Income', 'Keno Income'],
    cogs: ['Gaming - State Tax', 'Gaming Monitoring Fees'],
    wages: 'DEPT' /* Gaming Machines department */
  }
};
/* Known spelling slips in the owner's Xero account names, treated as the same account. */
const NAME_FIXES = [[/restuarant/g, 'restaurant']];
function normName(s) {
  let t = String(s || '').toLowerCase();
  NAME_FIXES.forEach((f) => { t = t.replace(f[0], f[1]); });
  return t.replace(/[–—−]/g, '-').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
}
const ALL_CENTRE_COGS = {};
Object.keys(CENTRES).forEach((k) => CENTRES[k].cogs.forEach((n) => { ALL_CENTRE_COGS[normName(n)] = true; }));
function centreKeys() {
  const keys = [];
  Object.keys(CENTRES).forEach((k) => { keys.push(k + '_sales', k + '_cogs'); if (CENTRES[k].wages !== null) keys.push(k + '_wages'); });
  return keys;
}

/* ---------------- Wages by department (owner's rules, 8 Oct 2026) ----------
   Xero payroll journals tag each wage line with the "Department" tracking
   category. The P&L report run per tracking category gives one column per
   department, so no journal-by-journal drilling is needed.
     Beverage        -> F&B and Bar
     Restaurant      -> F&B
     Kitchen         -> Kitchen
     Gaming Machines -> Gaming
     Ripley DBS      -> Retail
     General         -> Overheads (taken out of staff wages)
   Super is all tagged General in Xero, so staff super is SHARED across
   departments in proportion to each department's wages (owner's choice).
   Owners' pay (Johnson lines) is never staff wages - it stays in Overheads. */
const DEPT_RULES = [
  { re: /beverage/i,  to: ['fb', 'bar'] },
  { re: /restaurant/i, to: ['fb'] },
  { re: /kitchen/i,   to: ['kitchen'] },
  { re: /gaming/i,    to: ['gaming'] },
  { re: /ripley/i,    to: ['retail'] },
  { re: /general/i,   to: ['overheads'] }
];
function deptTargets(name) {
  const r = DEPT_RULES.filter((x) => x.re.test(name || ''))[0];
  return r ? r.to : null;
}
async function xeroDeptCategory(env, h) {
  const tenant = await xeroTenant(env, h);
  const key = 'xero:deptcat:' + tenant.id;
  const tok = await h.getTokens();
  const stamp = (tok && tok.obtained_at) || '';
  const hit = await env.TOKENS.get(key);
  /* A cached result only counts for the same Xero connection: after a
     Reconnect (new permissions) look again straight away. */
  if (hit) { try { const c = JSON.parse(hit); if (c.stamp === stamp) return c; } catch (e) {} }
  let pick = null, reason = null;
  try {
    const data = await h.fetchJson('https://api.xero.com/api.xro/2.0/TrackingCategories', { headers: { 'xero-tenant-id': tenant.id, Accept: 'application/json' } });
    const cats = (data && data.TrackingCategories) || [];
    pick = cats.filter((c) => /department/i.test(c.Name))[0]
      || cats.filter((c) => (c.Options || []).some((o) => /kitchen|beverage/i.test(o.Name)))[0] || null;
    if (!pick) reason = 'No "Department" tracking category found in Xero.';
  } catch (e) {
    reason = (e.status === 401 || e.status === 403)
      ? 'Xero needs one more read-only permission to see departments. Click Reconnect on the Connections screen.'
      : 'Couldn’t read departments from Xero just now.';
  }
  const out = pick ? { id: pick.TrackingCategoryID, name: pick.Name, options: (pick.Options || []).map((o) => o.Name), stamp: stamp } : { id: null, reason: reason, stamp: stamp };
  try { await env.TOKENS.put(key, JSON.stringify(out), { expirationTtl: pick ? 21600 : 300 }); } catch (e) {}
  return out;
}
/* Department P&L -> { wages: {dept: cents}, super: {dept: cents}, lines } */
async function xeroDeptPnl(env, h, params, ttl) {
  const cat = await xeroDeptCategory(env, h);
  if (!cat || !cat.id) return { unavailable: (cat && cat.reason) || 'Departments unavailable.' };
  const rep = await xeroPnl(env, h, { ...params, trackingCategoryID: cat.id }, ttl);
  const header = (rep.Rows || []).filter((r) => r.RowType === 'Header')[0];
  const names = header ? (header.Cells || []).map((c) => String(c.Value || '')) : [];
  const out = { category: cat.name, wages: {}, super: {} };
  (rep.Rows || []).forEach((sec) => {
    if (sec.RowType !== 'Section' || classifySection(sec.Title) !== 'opex') return;
    (sec.Rows || []).forEach((r) => {
      if (r.RowType !== 'Row') return;
      const label = r.Cells && r.Cells[0] ? r.Cells[0].Value : '';
      if (!isWageLine(label)) return;
      const bucket = /super/i.test(label) ? out.super : out.wages;
      for (let i = 1; i < names.length; i++) {
        if (/^total/i.test(names[i].trim())) continue;
        const v = toCents(r.Cells && r.Cells[i] ? r.Cells[i].Value : 0);
        bucket[names[i]] = (bucket[names[i]] || 0) + v;
      }
    });
  });
  return out;
}
/* Allocate department wages (+ shared super) onto the figures for one period. */
function applyDeptWages(figures, d) {
  if (!figures) return;
  if (!d || d.unavailable) { figures.deptNote = d ? d.unavailable : null; return; }
  const depts = Object.keys(d.wages).concat(Object.keys(d.super).filter((k) => !(k in d.wages)));
  const totalWages = depts.reduce((s, k) => s + (d.wages[k] || 0), 0);
  const totalSuper = depts.reduce((s, k) => s + (d.super[k] || 0), 0);
  const share = (k) => (totalWages ? Math.round((d.wages[k] || 0) / totalWages * totalSuper) : 0);
  const acc = { fb: 0, bar: 0, kitchen: 0, gaming: 0, retail: 0, overheads: 0, unassigned: 0 };
  depts.forEach((k) => {
    const amt = (d.wages[k] || 0) + share(k);
    const to = deptTargets(k);
    if (!to) acc.unassigned += amt; else to.forEach((t) => { acc[t] += amt; });
  });
  /* If most wages in this period carry NO department in Xero (e.g. before the
     bookkeeper started tagging), a department figure would be a misleading $0:
     leave the department tiles empty and say why. */
  const allAmt = Object.keys(acc).reduce((t, k) => t + acc[k], 0);
  if (allAmt <= 0 || acc.unassigned > allAmt * 0.5) {
    figures.deptNote = 'Xero has no department split for most wages in these dates (department tagging started later), so this can\u2019t be shown for this period.';
    figures.unassignedWages = acc.unassigned / 100;
    return;
  }
  ['fb', 'bar', 'kitchen', 'gaming', 'retail'].forEach((k) => { figures[k + '_wages'] = acc[k] / 100; });
  /* FOH labour for the bonus sheet: General + Food (Kitchen, Restaurant) + Beverage,
     each with its super share; no Gaming, Ripley or Johnson. */
  let foh = 0;
  depts.forEach((k) => { if (/general|kitchen|restaurant|beverage/i.test(k)) foh += (d.wages[k] || 0) + share(k); });
  figures.foh_wages = foh / 100;
  /* General department wages + its share of super move from staff wages to Overheads. */
  figures.wagesSuper = Math.round(figures.wagesSuper * 100 - acc.overheads) / 100;
  figures.overheads = Math.round(figures.overheads * 100 + acc.overheads) / 100;
  figures.generalWages = acc.overheads / 100;
  figures.unassignedWages = acc.unassigned / 100;
}

/* ---------------- Month-end stocktake gate (owner, 9 Oct 2026) -------------
   Cost of goods is only meaningful once the month-end stocktake journal is in
   Xero, so it is hidden for any month that doesn't have it yet. A month counts
   as "stocktaken" when its P&L has a non-zero stock line (name matching
   STOCK_RE, e.g. "Opening Stock" / "Closing Stock" / "Stock Movement").
   The owner can also mark a month as stocktaken from the dashboard. */
const STOCK_RE = /\b(stock|inventory)\b/i;
async function stocktakeStatus(env, h) {
  const now = new Date();
  const last = now.toISOString().slice(0, 7);
  const [ly, lm] = last.split('-').map(Number);
  const ld = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
  const rep = await xeroPnl(env, h, { fromDate: last + '-01', toDate: last + '-' + String(ld).padStart(2, '0'), periods: '11', timeframe: 'MONTH' }, 3600);
  const months = monthList(new Date(Date.UTC(ly, lm - 12, 1)).toISOString().slice(0, 7), last); /* oldest..newest, 12 */
  const done = {};
  (rep.Rows || []).forEach((sec) => {
    if (sec.RowType !== 'Section') return;
    const cls = classifySection(sec.Title);
    if (cls !== 'cogs' && cls !== 'opex') return;
    (sec.Rows || []).forEach((r) => {
      if (r.RowType !== 'Row' || !STOCK_RE.test(r.Cells && r.Cells[0] ? r.Cells[0].Value : '')) return;
      for (let i = 0; i < 12; i++) {
        if (toCents(r.Cells && r.Cells[i + 1] ? r.Cells[i + 1].Value : 0) !== 0) done[months[11 - i]] = true;
      }
    });
  });
  /* The owner can also mark a month's stocktake as posted (one click). */
  try { const sh = JSON.parse((await env.TOKENS.get('sys:shared')) || '{}'); Object.keys(sh.stocktake || {}).forEach((m) => { if (sh.stocktake[m]) done[m] = true; }); } catch (e) {}
  /* Only the current month and last month can be waiting: the current month
     always is (stocktake happens at month end); last month until its stocktake
     is detected or marked. Older months are treated as closed. */
  return { active: true, done: done, window: [months[10], months[11]], current: months[11], previous: months[10] };
}
function monthsInRange(from, to) { return monthList(from.slice(0, 7), to.slice(0, 7)); }
const COGS_FIELDS = ['fb_cogs', 'kitchen_cogs', 'bar_cogs', 'retail_cogs', 'cogs'];
function applyStockGate(figures, months, st) {
  if (!figures || !st || !st.active) return;
  const pending = months.filter((m) => st.window.indexOf(m) >= 0 && !st.done[m]);
  if (!pending.length) return;
  COGS_FIELDS.forEach((k) => { if (k in figures) figures[k] = null; });
  const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  figures.cogsNote = 'Cost of goods shows once the month-end stocktake for ' + pending.map((m) => MN[+m.slice(5) - 1]).join(' and ') + ' is in Xero.';
}

function xeroColumns(rep, n) {
  /* Overall Cost of goods (owner's choice): every line named in a cost
     centre's COGS list, plus any other line named "COGS", wherever it sits.
     Everything else in Cost of Sales + Operating Expenses that is not COGS or
     staff wages is Overheads, so Revenue - COGS - wages - Overheads = the P&L. */
  const cols = [];
  for (let i = 0; i < n; i++) cols.push({ c: { revenue: 0, cogsSection: 0, cogsAll: 0, wages: 0, opex: 0, gaming: 0 }, byName: {}, lines: [] });
  (rep.Rows || []).forEach((sec) => {
    if (sec.RowType !== 'Section') return;
    const cls = classifySection(sec.Title);
    if (!cls) return;
    const rows = sec.Rows || [];
    const summary = rows.filter((r) => r.RowType === 'SummaryRow')[0];
    const detail = rows.filter((r) => r.RowType === 'Row');
    for (let i = 0; i < n; i++) {
      const col = cols[i];
      const amt = (r) => toCents(r.Cells && r.Cells[i + 1] ? r.Cells[i + 1].Value : 0);
      const total = summary ? amt(summary) : detail.reduce((s, r) => s + amt(r), 0);
      detail.forEach((r) => {
        const label = r.Cells && r.Cells[0] ? r.Cells[0].Value : '';
        const key = normName(label);
        col.byName[key] = (col.byName[key] || 0) + amt(r);
        let as = cls;
        const isCogs = ((cls === 'cogs' || cls === 'opex') && (ALL_CENTRE_COGS[key] || COGS_RE.test(label))) || (cls === 'cogs' && STOCK_RE.test(label));
        if (isCogs) { as = 'cogs'; col.c.cogsAll += amt(r); }
        else if (cls === 'opex' && isWageLine(label)) { as = 'wages'; col.c.wages += amt(r); }
        else if (cls === 'cogs') { as = 'opex'; }
        if (cls === 'revenue' && GAMING_RE.test(label)) col.c.gaming += amt(r);
        if (i === 0) col.lines.push({ section: sec.Title, label: label, key: key, as: as, cents: amt(r), wageLike: cls === 'cogs' && WAGE_RE.test(label) });
      });
      if (cls === 'revenue') col.c.revenue += total;
      if (cls === 'cogs') col.c.cogsSection += total;
      if (cls === 'opex') col.c.opex += total;
    }
  });
  return cols.map((col) => {
    const c = col.c;
    const sum = (names) => names.reduce((s, nm) => s + (col.byName[normName(nm)] || 0), 0);
    const overheads = c.cogsSection + c.opex - c.cogsAll - c.wages;
    const figures = {
      revenue: c.revenue / 100,
      cogs: c.cogsAll / 100,
      wagesSuper: c.wages / 100,
      overheads: overheads / 100,
      gamingRevenue: c.gaming / 100
    };
    Object.keys(CENTRES).forEach((k) => {
      const ce = CENTRES[k];
      figures[k + '_sales'] = sum(ce.sales) / 100;
      figures[k + '_cogs'] = sum(ce.cogs) / 100;
      if (ce.wages === 'ALL_STAFF') figures[k + '_wages'] = c.wages / 100;
      else if (Array.isArray(ce.wages)) figures[k + '_wages'] = ce.wages.length ? sum(ce.wages) / 100 : null;
      else if (ce.wages === 'DEPT') figures[k + '_wages'] = null; /* filled by applyDeptWages */
    });
    return { lines: col.lines, byName: col.byName, figures: figures };
  });
}

/* Owner-readable page: how each line of their Xero P&L is counted. Used at
   reconciliation to confirm the wage/super list (a business question). */
async function accountsPage(env, url) {
  const h = makeHelpers(env, 'accounting');
  const now = new Date();
  const lmEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const from = url.searchParams.get('from') || (lmEnd.toISOString().slice(0, 8) + '01');
  const to = url.searchParams.get('to') || lmEnd.toISOString().slice(0, 10);
  let body;
  try {
    const tenant = await xeroTenant(env, h);
    const rep = await xeroPnl(env, h, { fromDate: from, toDate: to }, 120);
    const col = xeroColumns(rep, 1)[0];
    const money = (c) => (c < 0 ? '−$' : '$') + (Math.abs(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const groups = [
      ['revenue', 'Counted as Revenue'], ['cogs', 'Counted as Cost of goods'],
      ['wages', 'Counted as Wages and super'], ['opex', 'Counted as Overheads'],
      ['otherIncome', 'Left out (Other Income)'], ['excluded', 'Left out (other sections)']
    ];
    body = '<h1>How your Xero numbers are counted</h1><p>' + escHtml(tenant.name) + ' · ' + from + ' to ' + to + ' · accrual basis, ex-GST</p>';
    groups.forEach((g) => {
      const ls = col.lines.filter((l) => l.as === g[0]);
      if (!ls.length) return;
      body += '<h2>' + g[1] + '</h2><table>' + ls.map((l) => '<tr><td>' + escHtml(l.label) + (l.wageLike ? ' <em>(sits in Cost of Sales)</em>' : '') + (l.as === 'revenue' && GAMING_RE.test(l.label) ? ' <em>(gaming/keno: left out of the excl.-gaming percentages)</em>' : '') + '</td><td>' + money(l.cents) + '</td></tr>').join('') + '</table>';
    });
    const CENTRE_NAMES = { fb: 'F&B', kitchen: 'Kitchen', retail: 'Retail', gaming: 'Gaming' };
    body += '<h1 style="margin-top:2.4rem">Cost centres</h1><p>Each tile group adds up exactly these Xero lines. "Not found" means no line with that exact name has an amount for these dates; check the spelling against your Xero account name.</p>';
    const allSales = {};
    Object.keys(CENTRES).forEach((k) => {
      const ce = CENTRES[k];
      ce.sales.forEach((nm) => { allSales[normName(nm)] = true; });
      const row = (nm) => { const v = col.byName[normName(nm)]; return '<tr><td>' + escHtml(nm) + '</td><td>' + (v === undefined ? '<em>not found</em>' : money(v)) + '</td></tr>'; };
      body += '<h2>' + CENTRE_NAMES[k] + '</h2><table><tr><td colspan="2"><b>Sales</b></td></tr>' + ce.sales.map(row).join('') + '<tr><td colspan="2"><b>Cost of goods</b></td></tr>' + ce.cogs.map(row).join('');
      if (ce.wages === 'DEPT') body += '<tr><td colspan="2"><b>Wages and super</b>: from Xero departments (see below)</td></tr>';
      else if (ce.wages === 'ALL_STAFF') body += '<tr><td colspan="2"><b>Wages and super</b>: all staff wages and super</td></tr>';
      else if (Array.isArray(ce.wages) && !ce.wages.length) body += '<tr><td colspan="2"><b>Wages and super</b>: <em>waiting for these accounts to be split out in Xero</em></td></tr>';
      else if (Array.isArray(ce.wages)) body += '<tr><td colspan="2"><b>Wages and super</b></td></tr>' + ce.wages.map(row).join('');
      body += '</table>';
    });
    const unassigned = col.lines.filter((l) => l.as === 'revenue' && !allSales[l.key]);
    if (unassigned.length) body += '<h2>Income lines not in any cost centre</h2><p>These count in overall Revenue only.</p><table>' + unassigned.map((l) => '<tr><td>' + escHtml(l.label) + '</td><td>' + money(l.cents) + '</td></tr>').join('') + '</table>';
    const dp = await xeroDeptPnl(env, h, { fromDate: from, toDate: to }, 120);
    body += '<h1 style="margin-top:2.4rem">Wages by department</h1>';
    if (dp.unavailable) {
      body += '<p>' + escHtml(dp.unavailable) + '</p>';
    } else {
      const ds = Object.keys(dp.wages).concat(Object.keys(dp.super).filter((k) => !(k in dp.wages)));
      const tw = ds.reduce((s, k) => s + (dp.wages[k] || 0), 0), ts = ds.reduce((s, k) => s + (dp.super[k] || 0), 0);
      const where = (k) => { const t = deptTargets(k); return t ? t.map((x) => ({ fb: 'F&B', bar: 'Bar', kitchen: 'Kitchen', gaming: 'Gaming', retail: 'Retail', overheads: 'Overheads' })[x]).join(' + ') : '<em>not mapped: counts in staff wages only</em>'; };
      body += '<p>From the Xero tracking category "' + escHtml(dp.category) + '". Staff super (' + money(ts) + ', tagged General in Xero) is shared across departments in proportion to wages. Owners\u2019 pay is not included.</p><table><tr><td><b>Department</b></td><td><b>Wages</b></td><td><b>+ super share</b></td><td><b>Goes to</b></td></tr>'
        + ds.map((k) => '<tr><td>' + escHtml(k) + '</td><td>' + money(dp.wages[k] || 0) + '</td><td>' + money(tw ? Math.round((dp.wages[k] || 0) / tw * ts) : 0) + '</td><td>' + where(k) + '</td></tr>').join('') + '</table>';
    }
    const f = col.figures;
    applyDeptWages(f, dp);
    body += '<h2>Totals</h2><table><tr><td>Revenue</td><td>' + money(Math.round(f.revenue * 100)) + '</td></tr><tr><td>Cost of goods</td><td>' + money(Math.round(f.cogs * 100)) + '</td></tr><tr><td>Wages and super</td><td>' + money(Math.round(f.wagesSuper * 100)) + '</td></tr><tr><td>Overheads</td><td>' + money(Math.round(f.overheads * 100)) + '</td></tr></table>';
  } catch (e) {
    body = '<h1>Not connected yet</h1><p>Connect Xero on the Connections screen first.</p>';
  }
  return htmlResponse('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="PA Hotel"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="theme-color" content="#FAF7F2"><title>How your numbers are counted</title><style>body{font-family:system-ui,sans-serif;background:#FAF7F2;color:#2A2420;max-width:720px;margin:2rem auto;padding:0 1rem}h1{font-size:26px}h2{font-size:17px;margin-top:1.6rem}p{color:#8C8075}table{width:100%;border-collapse:collapse;background:#fffdf9}td{padding:6px 10px;border-bottom:1px solid #eee}td:last-child{text-align:right;white-space:nowrap}</style></head><body>' + body + '<p><a href="/">Back to your dashboard</a></p></body></html>');
}
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="PA Hotel"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="theme-color" content="#FAF7F2"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-title" content="PA Hotel"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="theme-color" content="#FAF7F2"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You’ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + '). Your AI will check the app settings - the usual cause is a redirect address that doesn’t match exactly.', { status: 502 });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn’t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn’t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it’s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: 'That file couldn’t be read. Check it’s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

async function fetchSlot(env, q) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  for (const source of ['accounting', 'pos', 'rostering']) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; continue; }
    try {
      const h = makeHelpers(env, source);
      out[source] = await adapter.fetchRange(env, h, q);
      await noteSync(env, source);
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
    }
  }
  return out;
}

const METRICS_CACHE_TTL = 120; /* seconds: brief cache for live provider data */

async function apiMetrics(env, url, board) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  /* Bonus tracker ranges (quarter to date; COGS only through stocktaken months). */
  const BONUS_KEYS = ['bq', 'bqc', 'bqc2'];
  const bonusRanges = {};
  BONUS_KEYS.forEach((k) => { const r = parseRange(url.searchParams.get(k)); if (r) bonusRanges[k] = r; });
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));

  const base = { tz, rollover };
  const [sAcc, sPos, sRos] = await Promise.all([
    sourceStatus(env, 'accounting'),
    sourceStatus(env, 'pos'),
    sourceStatus(env, 'rostering')
  ]);

  /* The provider calls (periods + trend) are the expensive part and the only
     thing that brushes provider rate limits on quick reopens/refreshes. Cache
     them briefly in KV, keyed by the requested ranges; source status stays live.
     generatedAt is stored with the data so the dashboard's "last synced" reflects
     the real fetch time even when served from cache. ?refresh=1 forces fresh. */
  const cacheKey = 'metricscache:' + [
    url.searchParams.get('cur') || '', url.searchParams.get('prev') || '',
    url.searchParams.get('yoy') || '', url.searchParams.get('trend') || '',
    url.searchParams.get('bq') || '', url.searchParams.get('bqc') || '', url.searchParams.get('bqc2') || '',
    tz, rollover
  ].join('|');
  const force = url.searchParams.get('refresh') === '1';
  let data = null;
  if (!force && env.TOKENS) {
    const cached = await env.TOKENS.get(cacheKey);
    if (cached) { try { data = JSON.parse(cached); } catch (e) { data = null; } }
  }
  if (!data) {
    const periods = {};
    periods.cur = await fetchSlot(env, { ...base, ...cur });
    periods.prev = prev ? await fetchSlot(env, { ...base, ...prev }) : null;
    periods.yoy = yoy ? await fetchSlot(env, { ...base, ...yoy }) : null;
    for (const k of Object.keys(bonusRanges)) periods[k] = await fetchSlot(env, { ...base, ...bonusRanges[k] });

    let trendOut = null;
    if (trend) {
      trendOut = { months: monthList(trend.fromMonth, trend.toMonth) };
      for (const source of ['accounting', 'pos']) {
        const adapter = ADAPTERS[source];
        if (!adapter || !adapter.configured) { trendOut[source] = null; continue; }
        try {
          const h = makeHelpers(env, source);
          const series = await adapter.fetchMonthly(env, h, { ...base, ...trend });
          trendOut[source] = alignSeries(trendOut.months, series);
        } catch (err) { trendOut[source] = null; }
      }
    }
    data = { generatedAt: new Date().toISOString(), periods: periods, trend: trendOut };
    if (env.TOKENS) {
      try { await env.TOKENS.put(cacheKey, JSON.stringify(data), { expirationTtl: METRICS_CACHE_TTL }); } catch (e) {}
    }
  }

  const payload = {
    generatedAt: data.generatedAt,
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: data.periods,
    trend: data.trend
  };
  let shared = {};
  try { shared = JSON.parse((await env.TOKENS.get('sys:shared')) || '{}'); } catch (e) {}
  if (board) { const fp = filterForBoard(payload, board); fp.shared = { targets: shared.targets || {} }; return json(fp); }
  payload.shared = { targets: shared.targets || null, recon: shared.recon || null };
  try {
    const st = await stocktakeStatus(env, makeHelpers(env, 'accounting'));
    payload.stocktake = { previous: st.previous, previousDone: !!st.done[st.previous], current: st.current };
  } catch (e) {}
  return json(payload);
}
/* Owner's verification ticks and KPI targets, kept on the server so they stay
   put across devices and reloads, and staff boards see the same targets. */
async function apiShared(env, request) {
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  let shared = {};
  try { shared = JSON.parse((await env.TOKENS.get('sys:shared')) || '{}'); } catch (e) {}
  if (body && body.targets && typeof body.targets === 'object') shared.targets = body.targets;
  if (body && body.recon && typeof body.recon === 'object') shared.recon = body.recon;
  if (body && body.stocktake && typeof body.stocktake === 'object') { shared.stocktake = shared.stocktake || {}; Object.keys(body.stocktake).forEach((m) => { if (/^\d{4}-\d{2}$/.test(m)) shared.stocktake[m] = !!body.stocktake[m]; }); }
  shared.updated = new Date().toISOString();
  await env.TOKENS.put('sys:shared', JSON.stringify(shared));
  return json({ ok: true });
}

/* ---------------- Staff boards (owner's request, 8 Oct 2026) ----------------
   Each staff member gets their own page at /board/<id> with their own
   password (set by the owner while logged in). Their data feed is cut down
   SERVER-SIDE to only their fields, so nothing else ever reaches their browser. */
const BOARDS = {
  /* bonus: monthly FOH bonus sheet (FOH Bonus - Amy Dyason and Adam Fitzgerald.xlsx) */
  adam:    { name: 'Adam',    role: 'Bar',     metrics: ['fbSales', 'fbCogs', 'fbWage', 'barCogs', 'barWage'], fields: ['fb_sales', 'fb_cogs', 'fb_wages', 'bar_sales', 'bar_cogs', 'bar_wages', 'foh_wages'],
             bonus: { cogs: 500, wages: 500, feedback: 250 } },
  amy:     { name: 'Amy',     role: 'F&B',     metrics: ['fbSales', 'fbCogs', 'fbWage'],            fields: ['fb_sales', 'fb_cogs', 'fb_wages', 'bar_sales', 'bar_cogs', 'foh_wages'],
             bonus: { cogs: 275, wages: 275, feedback: 200 } },
  stephen: { name: 'Stephen', role: 'Kitchen', metrics: ['kSales', 'kCogs', 'kWage'],               fields: ['kitchen_sales', 'kitchen_cogs', 'kitchen_wages'] }
};
const BOARD_VENUE = 'PA Hotel';
/* 180x180 PNG home-screen icon: 'PA' on black with a gold bar. */
const APP_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAI60lEQVR42u2de1BU1x3Hd1meIosIUkBRVMjiI5UAKg8RBUF5w77JY9JM0iZjO9NpG5rYTpw0TZu0Nh3bjk1ibaqNec0kuA9gQQgCBgySKNWoIBqTmUBkERFWkd2F3f5BHybC8ru717t34fsZ/1D23HOvdz+c3/mde+45wqCgIAEAU+GFWwAgB4AcAHIAyAEgB4AcAHIAyAEgB4AcAEAOADkA5ACQA0AOADkA5ACQA0AOADkAgBwAcgDIASAHgBwAcgDIASAHgBwAcgAAOQDkAJADQA4AOQDkAJADQA4AOQDkAJADAMgBIAeAHAByAMgBIAfwELzde/r2tpbY2JWu12O32y1Wq3nMfPPmzYGBgX7jwKVLly/29Jw+3Xn+QpfNZrtH16/TvJ+elsroEJvNlpC0sbe3D3JwhFAo9PP19fP1FYuDoqIiBQJBbk725EfDwyPHmpo1Wv3Ro/Vmi4XFk0YvWZKWmsK4rfbyUshle//0F4QV9xMcLC4tKTr4xv4znR0/r/ipWMzatmUqlVwoFDpxYLlKgT4HvwgLC3um4mcd7a0PPahmRw6F3LkDY2NXJiYmQA7+KRIa+ue9r/zz4AEXm5AN65NXrFju9OFqlRJy8JSC/Dy9tnLRokXONxtKl0KDtLTE19cHcvCUtWtWayrfc27nVD9f37LSYlfOHhKyIDcnB3Lwl3iJZP9r+5w4MC9ve3Cw2MWz879bOtcHwXJzsp3on7oYUybJzs4KCw2FHLxm93O/CAgIYJT1ZG3NdP28Pj7eUmkp5GCBru7u0PDFU/6Jjom7PyFZpij/wyt7+/q+diJ/eex7j9DLK+Rl3t7sDB6qlXLIcW8ZHR3t6/u6qbnlpd/tSVyfsvv5F6zWcUY1PFiucksWum7dd+MlEsjBEVbr+L6/vq4qf3h8nIEfq+LjJZL7KCXXrF61ds1qFi9YrVZADk5pbjn+4m9eZnRIOu0pCb3Z+PzzK6QgJZOKRCLIwSn7D7xx9Wo/vXxSUuKMZUQikVxG6kKeOXN236uvUUpGRHwnc3MG5OAUs9lcXWOgl4+JWTZjmaytmeHh4ZTaKo9odbpqYmhT8bVbOptT2bYTH9MLL14cxVZMsdvtR7S660NDzS3HKeULC/KcG6iFHM7DKKwEBgY6LiAWB+XtyKVUdbLjk6++6hUIBEc0Okp5f3//kuJCyMEpIyMj9MIB/v6OC5SVlvj5+RFjyuRfqmsMxOlF/Iwss1kOsZjB44/bY2MzxRRSzjkxMaHVVf3XTlNj4zHKUakpG5ctXQo5uCMyMoJe+NatWw4+Xb48ZsP6ZEo9rW0nBgYG7m5FHCMUCpVKGeTgjjQmU38dz/hVk5+0fVCpufOftXX1t2/fpkUWBeTgCH9//8L8HfTyV6584fqvtdU6XlVdc+dPRkdH6442UI5dHrMsZeMGyMEFT/3gCeKYxCSffnpq2hYoNWVpdDSlksZjTTduDE/XP/W4bunslCNr65Zdz1YwOqR1+kERNXlWzhHNFB40NHxoMpkoh5eWFBMTIsjhDD4+3j/a+dTbhw8xeqp+oavr4sWeqVPcgIDiogJKJWNjYzWGurt/brZYDLV1tPQqKD9vO+RguXsRGRmRuTlj1zMVpzo+/tXzz/n4MJtv8dbb7073UWFB3vz58ymV1B1tmC7loUcWNZ/mDnrMG2/xEsmgsfde1HxtcPDgocOuf1sODGhqbrk+NLQwJGTGSrZuyQwPDzcajWg5eMELv/7tdNlmZGTE5oxNlEpMJlN9w4eOspiqGko9IpFIIS9DWOEF9Q2NDmKKUi7z8iLdohpDndlsdthX1REviT/vO81pObq6u7//5E5WcssZexUftbYRg8XqVfH3r10DOdzJufMXymRqB0lmQsI64tzB60NDTc0tjsvYbDadvtqzuqVzVI4aQ21RidTxrzL9pSPivB56ziKXsTbBHXIwy01+/JOnH3n08eHhEcfjJWVlJdSYotFQip3s+IS4ZktYWFh21hbIwakWv9/zxw0pmw6/9c6MhXO2bQtduJBS7dWr/SdOtFNK2u12jVbvQd1S71nvxPDwSFNzi1anr62rd5xQfPO7oXZFtTo9fVmpSo32hzufpJTcvj1nwYLgu5/UcInQvbMX2VoTTCAQWCxWi8VsMt0cuHatv994+fLl7os9nZ3/+uzceaZrgi0MCTl39rTbl0h4uuLZfxx6Ey0HKe1Mz8ji5lxSaSkfFs9Qq5XulQMjpFN9K/x4dJ6clLhy5QrIwSPi4mIfeCCBN5oqIAefmg0+PRdVKKTOLVgIOe7B7fDyUsp5NNE3esmS9PRUyMELNmdsmlzjlj+Uu2/AA3J8A5WKdy8XFRXmz5s3D3K4mcDAwKKCfB5eVaGbrgpy/J/iogJGi4Nx2Ed2T3vmDSeciO77//b3Xb/c7eLp4iWS1uONlJIZm9KjoiKdWO4MLQdreUFaGnULBPrMDAd0dXf39Fyi5lAKNzQekOM/KJUy4oiC0WhsP9nBykn1tImlAjcN2kKO/9196tiXvtrA1u4++ipqCxQXF8v9RguQQyAQCNYnJ9G3QNDpq9g675mzn33x5Zes6ws52E0HqF3Ra4ODxKk9rEcWaRnXz4ohB7MtEKqrDRMTE2zKQe7bcr/RAuQQ7NiRS98CgZU85U5One6kbwbI8YAH5GAQU4aGbnzU2sbu2e12+7eW9HDAtuxs4sxWyMECjLZAqDHUMlo1m/VuB8cbLcx1ORhtgcB6TJmk/WQH/c1pLrfwEfJzeVTAB9DnAJADQA4AOQDkAJADQA4AOQDkAJADQA4AIAeAHAByAMgB3IJnvA7Ze8A0+2794if4PpOG75N9ZqUWnqIIwgrwTDlmfbPB8/8jWg4AOcAsk4P//Xl0SMEcxTPeW8E4B+QACCsAcgDIASAHgBwAQA4AOQDkAJADQA4AOQDkAJADQA4AOQCAHAByAMgBIAeAHAByAMgBIAeAHAByAMgBAOQAkANADgA5AOQAkANADgA5AOQAkAMAyAEgB4AcAHIAyAEgB4AcAHIAyAEgBwCQA0AO4Az/Bo9Rqah05r2PAAAAAElFTkSuQmCC';
function pickFields(obj, fields) {
  if (!obj) return null;
  const out = {};
  fields.forEach((f) => { if (f in obj) out[f] = obj[f]; });
  return out;
}
function filterForBoard(p, board) {
  const flds = board.fields.concat(['cogsNote', 'deptNote']);
  const slot = (sl) => (sl ? { accounting: pickFields(sl.accounting, flds), pos: null, rostering: null } : null);
  const acc = p.sources.accounting || {};
  return {
    generatedAt: p.generatedAt,
    protected: true,
    board: true,
    sources: {
      accounting: { configured: !!acc.configured, connected: !!acc.connected, lastSync: acc.lastSync || null, error: acc.error || null },
      pos: { configured: false }, rostering: { configured: false }
    },
    periods: { cur: slot(p.periods.cur), prev: slot(p.periods.prev), yoy: slot(p.periods.yoy), bq: slot(p.periods.bq), bqc: slot(p.periods.bqc), bqc2: slot(p.periods.bqc2) },
    trend: p.trend ? { months: p.trend.months, accounting: pickFields(p.trend.accounting, board.fields), pos: null } : null
  };
}
async function boardPasswordSet(env, id) {
  return !!(env.TOKENS && await env.TOKENS.get('sys:board_hash:' + id));
}
async function makeBoardSession(env, id) {
  const payload = 'b1.' + id + '.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validBoardSession(request, env, id) {
  const token = getCookie(request, 'vd_board_' + id);
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const parts = payload.split('.');
  if (parts[0] !== 'b1' || parts[1] !== id) return false;
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(parts[2], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function boardCookie(id, token, maxAge) {
  return 'vd_board_' + id + '=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + maxAge;
}
async function apiBoardSetup(env, request, id) {
  /* Only the OWNER (logged in to the main dashboard) can set or change a staff password. */
  if (!(await isLoggedIn(request, env))) return json({ ok: false, error: 'owner_only' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:board_hash:' + id, saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  return json({ ok: true });
}
async function apiBoardLogin(env, request, id) {
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  const stored = await env.TOKENS.get('sys:board_hash:' + id);
  if (!stored) return json({ ok: false }, 400);
  const dot = stored.indexOf('.');
  if (!timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1))) return json({ ok: false }, 401);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': boardCookie(id, await makeBoardSession(env, id), SESSION_TTL) } });
}
function boardSetupPage(id, board, hasPassword) {
  return setupPage()
    .replace('<title>Set your password</title>', '<title>' + board.name + '\u2019s board</title>')
    .replace('<h1>Set your password</h1>', '<h1>' + board.name + '\u2019s board (' + board.role + ')</h1>')
    .replace(/<p>Choose a password for your dashboard\.[^<]*<\/p>/, '<p>' + (hasPassword ? 'Change' : 'Choose') + ' the password ' + board.name + ' will use to open this board. Only you can set it, while you\u2019re signed in to your main dashboard. At least 6 characters.</p>' + (hasPassword ? '<p><a href="/board/' + id + '?view=1">Skip, just view the board</a></p>' : ''))
    .replace('Save and open my dashboard', 'Save ' + board.name + '\u2019s password')
    .replace('"/api/setup"', '"/api/board/' + id + '/setup"')
    .replace('if(r.ok){location.reload();}', 'if(r.ok){location.href="/board/' + id + '?view=1";}');
}
function boardLoginPage(id, board) {
  return loginPage()
    .replace('<h1>Your dashboard</h1>', '<h1>' + board.name + '\u2019s board</h1>')
    .replace('Enter the password for this dashboard.', 'Enter your password to see your numbers.')
    .replace('"/api/login"', '"/api/board/' + id + '/login"');
}
function boardNotReadyPage(board) {
  return loginPage().replace(/<form[\s\S]*<\/form>/, '<p>This board isn\u2019t set up yet. Ask your manager to set your password.</p>').replace('<h1>Your dashboard</h1>', '<h1>' + board.name + '\u2019s board</h1>').replace('<p>Enter the password for this dashboard.</p>', '');
}
async function serveBoard(env, request, url, id) {
  const board = BOARDS[id];
  const owner = await isLoggedIn(request, env);
  const staff = await validBoardSession(request, env, id);
  const hasPw = await boardPasswordSet(env, id);
  if (owner && (!hasPw || url.searchParams.get('setup') === '1')) return htmlResponse(boardSetupPage(id, board, hasPw));
  if (owner || staff) {
    const cfg = { id: id, name: board.name, role: board.role, metrics: board.metrics, venue: BOARD_VENUE, owner: owner, bonus: board.bonus || null };
    return htmlResponse(dashboardHtml.replace('<div id="app">', '<script>window.VD_BOARD = ' + JSON.stringify(cfg).replace(/</g, '\\u003c') + ';</script>\n<div id="app">'));
  }
  return htmlResponse(hasPw ? boardLoginPage(id, board) : boardNotReadyPage(board));
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    if (path === '/apple-touch-icon.png' || path === '/apple-touch-icon-precomposed.png') {
      /* Home-screen icon for phones (owner request, 8 Oct 2026). Public, no data. */
      const bin = Uint8Array.from(atob(APP_ICON_B64), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(dashboardHtml);
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    const boardRoute = /^\/board\/([a-z]+)$/.exec(path);
    if (boardRoute && BOARDS[boardRoute[1]] && request.method === 'GET') return serveBoard(env, request, url, boardRoute[1]);
    const boardApi = /^\/api\/board\/([a-z]+)\/(setup|login|logout|metrics)$/.exec(path);
    if (boardApi && BOARDS[boardApi[1]]) {
      const bid = boardApi[1], act = boardApi[2];
      if (act === 'setup' && request.method === 'POST') return apiBoardSetup(env, request, bid);
      if (act === 'login' && request.method === 'POST') return apiBoardLogin(env, request, bid);
      if (act === 'logout' && request.method === 'POST') return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': boardCookie(bid, '', 0) } });
      if (act === 'metrics' && request.method === 'GET') {
        if (!(loggedIn || await validBoardSession(request, env, bid))) return json({ error: 'auth' }, 401);
        return apiMetrics(env, url, BOARDS[bid]);
      }
    }
    if (path === '/api/shared' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiShared(env, request);
    }
    if (path === '/accounts' && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return accountsPage(env, url);
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
