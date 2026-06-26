/* ============================================================================
 * insforge-client.js — Browser-side InsForge integration for the APBD NTB
 * dashboard. Loads @insforge/sdk from a CDN (no build step), hydrates a cache
 * the existing (synchronous) UI reads from, and provides admin auth + import.
 *
 * Activation: define window.APBD_CONFIG = { baseUrl, anonKey } (see
 * insforge-config.js). If absent, the dashboard stays in offline/demo mode and
 * this module is a no-op.
 *
 * Exposes window.APBD with:
 *   configured(): boolean
 *   ready: Promise<boolean>        // resolves true when remote cache is hydrated
 *   store: { regions, years, summary(slug,year), ratios(slug,year),
 *            recs(slug,year), statement(slug,year,tab), audited(slug,year) }
 *   auth:  { signIn, signOut, getUser, isAdmin }
 *   importFile(file, regionSlug, year, audited): Promise<result>
 *   regenerate(regionSlug, year): Promise<result>
 * ========================================================================== */
(function () {
  const cfg = (typeof window !== 'undefined' && window.APBD_CONFIG) || null;
  const B = 1e9; // rupiah -> miliar (frontend works in "miliar" units)

  const store = {
    regions: null,            // [{id:slug,name,short,type}]
    years: null,              // [2021..]
    _summary: {}, _ratios: {}, _recs: {}, _stmt: {}, _audited: {},
    summary(slug, year) { return this._summary[slug + ':' + year] || null; },
    ratios(slug, year) { return this._ratios[slug + ':' + year] || null; },
    recs(slug, year) { return this._recs[slug + ':' + year] || null; },
    statement(slug, year, tab) { const k = slug + ':' + year; return (this._stmt[k] && this._stmt[k][tab]) || null; },
    audited(slug, year) { return !!this._audited[slug + ':' + year]; },
    hasYearRegion(slug, year) { return !!this._summary[slug + ':' + year]; },
  };

  let sdk = null;
  const API = {
    configured: () => !!cfg,
    store,
    ready: Promise.resolve(false),
    auth: {},
  };

  if (!cfg) { window.APBD = API; return; }

  async function loadSdk() {
    if (sdk) return sdk;
    const mod = await import(/* @vite-ignore */ (cfg.sdkUrl || 'https://esm.sh/@insforge/sdk@latest'));
    sdk = mod.createClient({ baseUrl: cfg.baseUrl, anonKey: cfg.anonKey });
    return sdk;
  }

  // ---- mapping helpers (DB rows -> frontend shapes) ----
  function mapSummary(row) {
    const plannedRev = row.total_planned_revenue / B;
    const realizedRev = row.total_realized_revenue / B;
    const plannedExp = row.total_planned_expenditure / B;
    const realizedExp = row.total_realized_expenditure / B;
    const padPlanned = row.pad_planned / B;
    const padRealized = row.pad_realized / B;
    const transferReal = row.transfer_realized / B;
    const exp = realizedExp || 1;
    return {
      plannedRev, realizedRev,
      serapan: plannedRev ? realizedRev / plannedRev : 0,
      padPlanned, padRealized,
      transfer: Math.max(0, plannedRev - padPlanned),
      transferReal,
      plannedExp, realizedExp,
      expSer: plannedExp ? realizedExp / plannedExp : 0,
      financing: row.net_financing / B,
      padEff: padPlanned ? padRealized / padPlanned : 0,
      bd: {
        pegawai: row.bd_pegawai / exp / B === Infinity ? 0 : (row.bd_pegawai / row.total_realized_expenditure) || 0,
        barang: (row.bd_barang / row.total_realized_expenditure) || 0,
        modal: (row.bd_modal / row.total_realized_expenditure) || 0,
        lain: (row.bd_lain / row.total_realized_expenditure) || 0,
      },
    };
  }
  function mapRatios(row) {
    if (!row) return null;
    return {
      ddf: row.ddf, rkk: row.rkk,
      efektivitas: row.efektivitas_pad,
      efisiensi: row.efisiensi_belanja,
      bmodal: row.belanja_modal_ratio,
      ketergantungan: row.ketergantungan,
    };
  }
  const refLabelFor = (ref) => ref === 'serapan' ? 'Lihat peta serapan'
    : (ref || '').startsWith('ratio') ? 'Lihat rasio kinerja'
    : 'Buka detail daerah';
  function mapRec(row) {
    const ref = row.data_ref || 'detail';
    const kind = ref.startsWith('ratio') ? 'rasio' : ref === 'serapan' ? 'serapan' : 'detail';
    return { title: row.title, reason: row.reason, priority: row.priority, ref: kind, refLabel: refLabelFor(ref) };
  }
  // statement_line rows -> { cols, rows, pctCol?, growthCol? } in MILIAR
  function buildStatement(tab, lines, curYear, prevYear) {
    lines = lines.slice().sort((a, b) => a.line_order - b.line_order);
    const mb = (v) => (v === null || v === undefined ? null : v / B);
    if (tab === 'LRA') {
      return { cols: ['Anggaran', 'Realisasi', '%', String(prevYear)], pctCol: 2,
        rows: lines.map((l) => ({ l: l.label, lv: l.level, k: l.kind, v: [mb(l.v0), mb(l.v1), null, mb(l.v3)] })) };
    }
    if (tab === 'LO') {
      return { cols: [String(curYear), String(prevYear), 'Naik/(Turun)', '%'], growthCol: true,
        rows: lines.map((l) => ({ l: l.label, lv: l.level, k: l.kind, v: [mb(l.v0), mb(l.v1)] })) };
    }
    return { cols: [String(curYear), String(prevYear)],
      rows: lines.map((l) => ({ l: l.label, lv: l.level, k: l.kind, v: [mb(l.v0), mb(l.v1)] })) };
  }

  async function hydrate() {
    const c = await loadSdk();
    // regions
    const { data: regs } = await c.database.from('region').select('id,slug,name,short,type').order('id', { ascending: true });
    const byId = {};
    (regs || []).forEach((r) => (byId[r.id] = r));
    store.regions = (regs || []).map((r) => ({ id: r.slug, name: r.name, short: r.short, type: r.type }));

    const slugOf = (rid) => byId[rid] && byId[rid].slug;

    // The API caps a single SELECT at 1000 rows. statement_line holds ~300 rows
    // per region (thousands total), so fetch it in pages or regions past the
    // first ~3 silently fall back to scaled demo data.
    async function selectAll(table, decorate) {
      const pageSize = 1000;
      const all = [];
      for (let from = 0; ; from += pageSize) {
        let q = c.database.from(table).select('*');
        if (decorate) q = decorate(q);
        const { data, error } = await q.range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || !data.length) break;
        all.push(...data);
        if (data.length < pageSize) break;
      }
      return all;
    }

    // yearly_summary + ratios + recommendations + statement_line
    const [sums, rats, recs, lines] = await Promise.all([
      selectAll('yearly_summary'),
      selectAll('ratio_result'),
      selectAll('recommendation', (q) => q.order('priority', { ascending: true })),
      selectAll('statement_line', (q) => q.order('id', { ascending: true })),
    ]);

    const years = new Set();
    (sums || []).forEach((row) => { const slug = slugOf(row.region_id); if (!slug) return; years.add(row.year); store._summary[slug + ':' + row.year] = mapSummary(row); store._audited[slug + ':' + row.year] = !!row.is_audited; });
    (rats || []).forEach((row) => { const slug = slugOf(row.region_id); if (slug) store._ratios[slug + ':' + row.year] = mapRatios(row); });
    const recMap = {};
    (recs || []).forEach((row) => { const slug = slugOf(row.region_id); if (!slug) return; const k = slug + ':' + row.year; (recMap[k] = recMap[k] || []).push(mapRec(row)); });
    store._recs = recMap;

    // group statement_line by region/year/statement
    const grp = {};
    (lines || []).forEach((l) => { const slug = slugOf(l.region_id); if (!slug) return; const k = slug + ':' + l.year; (grp[k] = grp[k] || {}); (grp[k][l.statement] = grp[k][l.statement] || []).push(l); });
    Object.keys(grp).forEach((k) => {
      const year = +k.split(':')[1]; const prev = year - 1; const out = {};
      Object.keys(grp[k]).forEach((tab) => { out[tab] = buildStatement(tab, grp[k][tab], year, prev); });
      store._stmt[k] = out;
    });

    store.years = [...years].sort((a, b) => a - b);
    if (!store.years.length) store.years = [2021, 2022, 2023, 2024, 2025];
    return true;
  }

  // ---- auth ----
  API.auth.signIn = async (email, password) => {
    const c = await loadSdk();
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  };
  API.auth.signOut = async () => { const c = await loadSdk(); await c.auth.signOut(); };
  API.auth.getUser = async () => { const c = await loadSdk(); const { data } = await c.auth.getCurrentUser(); return data?.user || null; };
  API.auth.isAdmin = async () => {
    const c = await loadSdk();
    const { data: ud } = await c.auth.getCurrentUser();
    if (!ud?.user?.id) return false;
    const { data } = await c.database.from('app_admin').select('user_id').eq('user_id', ud.user.id);
    return !!(data && data.length);
  };

  // ---- admin import (upload -> storage -> invoke import-report) ----
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  // Edge functions do heavy work (parse + many DB writes) and the long-lived
  // connection to the function host can intermittently drop, surfacing as a
  // NETWORK_ERROR / statusCode 0 / 408 / 5xx. Imports are idempotent per
  // region+year (the function deletes then re-inserts), so retrying is safe.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function isTransient(err) {
    if (!err) return false;
    const code = err.error || err.code || '';
    const sc = err.statusCode;
    return code === 'NETWORK_ERROR' || code === 'FUNCTION_ERROR' || code === 'REQUEST_TIMEOUT' ||
      sc === 0 || sc === 408 || sc === 425 || sc === 429 || sc === 500 || sc === 502 || sc === 503 || sc === 504;
  }
  async function invokeWithRetry(c, slug, body, tries = 3) {
    let lastErr = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const { data, error } = await c.functions.invoke(slug, { body });
        if (!error) return data;
        lastErr = error;
        if (!isTransient(error)) throw error;
      } catch (e) {
        lastErr = e;
        if (!isTransient(e)) throw e;
      }
      if (attempt < tries) await sleep(1500 * attempt);
    }
    throw lastErr || new Error('Function invocation failed');
  }
  API.importFile = async (file, regionSlug, year, audited) => {
    const c = await loadSdk();
    let storageKey = null;
    try {
      const bucket = cfg.storageBucket || 'reports';
      const key = `${regionSlug}/${year}/${Date.now()}-${file.name}`;
      const up = await c.storage.from(bucket).upload(key, file);
      storageKey = up?.data?.key || key;
    } catch (_e) { /* storage optional; function parses the inline file */ }
    const fileBase64 = await fileToBase64(file);
    // 1) import data (fast; rule-based recs written inline) — retried on transient drops
    const data = await invokeWithRetry(c, 'import-report', { regionSlug, year, audited: !!audited, fileBase64, fileName: file.name, storageKey });
    // 2) upgrade to AI recommendations (best-effort; rule-based recs already saved)
    try {
      const ai = await invokeWithRetry(c, 'generate-recommendations', { regionSlug, year }, 2);
      if (ai && typeof ai.recommendations === 'number') data.recommendations = ai.recommendations;
    } catch (_e) { /* keep rule-based recs if AI step fails */ }
    return data;
  };
  API.regenerate = async (regionSlug, year) => {
    const c = await loadSdk();
    return invokeWithRetry(c, 'generate-recommendations', { regionSlug, year }, 3);
  };

  API.refresh = () => hydrate().then(() => true).catch((e) => { console.warn('[APBD] refresh failed:', e); return false; });
  API.ready = hydrate().then(() => true).catch((e) => { console.warn('[APBD] InsForge hydrate failed, staying in demo mode:', e); return false; });
  window.APBD = API;
})();
