// ============================================================================
// import-report — Admin-only edge function (Deno / InsForge).
//
// Accepts an uploaded BPK .xlsx (6 sheets: LRA, LPSAL, Neraca, LO, LAK, LPE),
// parses it, and upserts the linked region/year into:
//   statement_line, yearly_summary, ratio_result, indicator_data,
//   budget_entry, upload_log — then regenerates recommendations.
//
// Auth: caller must be authenticated AND listed in public.app_admin.
// Writes use the admin API key (bypasses RLS).
//
// Request (POST, JSON):
//   { regionSlug: string, year?: number, audited?: boolean,
//     fileBase64: string, fileName?: string }
//
// Deploy:  npx @insforge/cli functions deploy import-report --file functions/import-report/index.ts
// Secrets: INSFORGE_BASE_URL, ANON_KEY (auto), INSFORGE_API_KEY (admin key),
//          OPENROUTER_API_KEY (optional, for AI recommendations)
// ============================================================================
import { createClient, createAdminClient } from 'npm:@insforge/sdk';
import * as XLSX from 'npm:xlsx';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------------------------------------------------------------------------
// Parser (kept in sync with scripts/lib/parse-statements.mjs)
// ---------------------------------------------------------------------------
const STATEMENTS = ['LRA', 'LPSAL', 'Neraca', 'LO', 'LAK', 'LPE'];
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^0-9.,()-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  if (!s || s === '-' || s === '()') return null;
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[()]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};
const isUpper = (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase();
const refDepth = (ref: unknown) => (ref ? String(ref).trim().split('.').filter(Boolean).length : 0);
const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/\s+/g, ' ').trim();

function findHeader(rows: any[][]) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const row = rows[r] || [];
    const idx = row.findIndex((c) => norm(c) === 'URAIAN');
    if (idx !== -1) return { headerRow: r, labelCol: idx, headerCells: row };
  }
  return { headerRow: 0, labelCol: 0, headerCells: rows[0] || [] };
}
function classifyColumns(headerCells: any[]) {
  const cols: any[] = [];
  headerCells.forEach((h, i) => {
    const t = norm(h); if (!t) return;
    if (/REF/.test(t)) return cols.push({ i, role: 'ref' });
    if (t === '%') return cols.push({ i, role: 'pct' });
    const year = (t.match(/(20\d\d)/) || [])[1];
    if (/ANGGARAN/.test(t)) return cols.push({ i, role: 'anggaran', year: year && +year });
    if (/REALISAS/.test(t)) return cols.push({ i, role: 'realisasi', year: year && +year });
    if (year) return cols.push({ i, role: 'year', year: +year });
    if (/NAIK|TURUN/.test(t)) return cols.push({ i, role: 'delta' });
  });
  return cols;
}
function detectYears(rows: any[][], cols: any[], headerRow: number) {
  const years = new Set<number>();
  cols.forEach((c) => c.year && years.add(c.year));
  if (years.size < 2) {
    for (let r = 0; r < headerRow; r++) for (const c of rows[r] || []) {
      if (typeof c !== 'string') continue;
      const m = c.toUpperCase().match(/\b(20\d\d)\b/g);
      if (m) m.forEach((y) => years.add(+y));
    }
  }
  const sorted = [...years].sort((a, b) => b - a);
  return { current: sorted[0] || null, prev: sorted[1] || (sorted[0] ? sorted[0] - 1 : null) };
}
function parseStatementSheet(ws: any, statement: string) {
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const { headerRow, labelCol, headerCells } = findHeader(rows);
  const cols = classifyColumns(headerCells);
  const { current, prev } = detectYears(rows, cols, headerRow);
  const refCol = (cols.find((c) => c.role === 'ref') || {}).i;
  const anggaranCol = (cols.find((c) => c.role === 'anggaran') || {}).i;
  const realisasiCurCol = (cols.find((c) => c.role === 'realisasi' && (!c.year || c.year === current)) || cols.find((c) => c.role === 'realisasi') || {}).i;
  const curYearCol = (cols.find((c) => c.role === 'year' && c.year === current) || {}).i;
  const prevCol = (cols.find((c) => (c.role === 'year' || c.role === 'realisasi') && c.year === prev) || {}).i;
  let baseDepth = Infinity;
  for (let r = headerRow + 1; r < rows.length; r++) { const d = refDepth(refCol != null ? rows[r]?.[refCol] : null); if (d) baseDepth = Math.min(baseDepth, d); }
  if (!Number.isFinite(baseDepth)) baseDepth = 0;
  const lines: any[] = []; let order = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || []; const label = row[labelCol];
    if (label == null || String(label).trim() === '') continue;
    const ls = String(label).trim();
    if (/^Catatan atas Laporan Keuangan/i.test(ls) || /BUPATI|WALIKOTA|TTD/i.test(ls)) break;
    const ref = refCol != null ? row[refCol] : null; const d = refDepth(ref);
    const level = d ? Math.max(0, Math.min(2, d - baseDepth)) : (isUpper(ls) ? 0 : 2);
    const kind = level === 0 ? 't' : level === 1 ? 's' : 'i';
    let v0 = null, v1 = null, v2 = null, v3 = null;
    if (statement === 'LRA') {
      v0 = anggaranCol != null ? num(row[anggaranCol]) : null;
      v1 = realisasiCurCol != null ? num(row[realisasiCurCol]) : null;
      v3 = prevCol != null ? num(row[prevCol]) : null;
    } else {
      v0 = curYearCol != null ? num(row[curYearCol]) : null;
      v1 = prevCol != null ? num(row[prevCol]) : null;
    }
    if (v0 == null && v1 == null && v3 == null && kind === 'i') continue;
    lines.push({ statement, line_order: order++, label: ls, ref_code: ref ? String(ref).trim() : null, level, kind, v0, v1, v2, v3 });
  }
  return { statement, years: { current, prev }, lines };
}
function pick(lines: any[], ...keys: string[]) { const K = keys.map(norm); return lines.find((l) => { const t = norm(l.label); return K.every((k) => t.includes(k)); }); }
function deriveFromLRA(L: any[]) {
  const val = (line: any, f: string) => (line && line[f] != null ? line[f] : 0);
  const pend = pick(L, 'PENDAPATAN DAERAH'), pad = pick(L, 'PENDAPATAN ASLI DAERAH'), transfer = pick(L, 'PENDAPATAN TRANSFER');
  const belanja = pick(L, 'BELANJA DAERAH'), belPegawai = pick(L, 'BELANJA PEGAWAI') || pick(L, 'PEGAWAI'), belBarang = pick(L, 'BARANG DAN JASA');
  const belModal = L.find((l) => norm(l.label) === 'BELANJA MODAL');
  const pembiayaan = pick(L, 'PEMBIAYAAN DAERAH NETTO') || pick(L, 'PEMBIAYAAN DAERAH');
  const total_planned_revenue = val(pend, 'v0'), total_realized_revenue = val(pend, 'v1');
  const total_planned_expenditure = val(belanja, 'v0'), total_realized_expenditure = val(belanja, 'v1');
  const net_financing = val(pembiayaan, 'v1'), pad_planned = val(pad, 'v0'), pad_realized = val(pad, 'v1');
  const transfer_realized = val(transfer, 'v1');
  const bd_pegawai = val(belPegawai, 'v1'), bd_barang = val(belBarang, 'v1'), bd_modal = val(belModal, 'v1');
  const bd_lain = Math.max(0, total_realized_expenditure - bd_pegawai - bd_barang - bd_modal);
  const summary = { total_planned_revenue, total_realized_revenue, total_planned_expenditure, total_realized_expenditure, net_financing, pad_planned, pad_realized, transfer_realized, bd_pegawai, bd_barang, bd_modal, bd_lain };
  const pct = (a: number, b: number) => (b ? (a / b) * 100 : null);
  const ratios = { ddf: pct(pad_realized, total_realized_revenue), rkk: pct(pad_realized, transfer_realized), efektivitas_pad: pct(pad_realized, pad_planned), efisiensi_belanja: pct(total_realized_expenditure, total_realized_revenue), belanja_modal_ratio: pct(bd_modal, total_realized_expenditure), ketergantungan: pct(transfer_realized, total_planned_revenue) };
  const indicators = [ { indicator_type: 'serapan', value: pct(total_realized_revenue, total_planned_revenue) }, { indicator_type: 'deviasi', value: pct(total_planned_expenditure - total_realized_expenditure, total_planned_expenditure) } ];
  const catOf = (l: any) => { const t = norm(l.label); if (t.includes('PENDAPATAN')) return 'pendapatan'; if (t.includes('BELANJA')) return 'belanja'; if (t.includes('PEMBIAYAAN') || t.includes('SILPA') || t.includes('SURPLUS')) return 'pembiayaan'; return null; };
  const budget_entries = L.filter((l) => l.level <= 1 && (l.v0 != null || l.v1 != null)).map((l) => { const category = catOf(l); return category ? { category, sub_category: l.label, ref_code: l.ref_code, level: l.level, planned_amount: l.v0 || 0, realized_amount: l.v1 || 0 } : null; }).filter(Boolean);
  return { summary, ratios, indicators, budget_entries };
}
function parseWorkbook(wb: any) {
  const out: any = { statements: {}, years: { current: null, prev: null } };
  for (const name of wb.SheetNames) {
    const canon = STATEMENTS.find((s) => s.toLowerCase() === name.trim().toLowerCase());
    if (!canon || out.statements[canon]) continue;
    out.statements[canon] = parseStatementSheet(wb.Sheets[name], canon);
    if (canon === 'LRA') out.years = out.statements[canon].years;
  }
  if (!out.years.current) { const any = Object.values(out.statements)[0] as any; if (any) out.years = any.years; }
  out.derived = out.statements.LRA ? deriveFromLRA(out.statements.LRA.lines) : null;
  return out;
}

// ---------------------------------------------------------------------------
// Rule-based recommendation fallback (mirrors the frontend heuristics)
// ---------------------------------------------------------------------------
function ruleRecs(summary: any, ratios: any) {
  const out: any[] = [];
  const serapan = summary.total_planned_revenue ? summary.total_realized_revenue / summary.total_planned_revenue : 0;
  const expSer = summary.total_planned_expenditure ? summary.total_realized_expenditure / summary.total_planned_expenditure : 0;
  const p = (x: number | null) => (x == null ? '-' : x.toFixed(1) + '%');
  if (serapan < 0.865) out.push({ title: 'Serapan belanja rendah pada akhir tahun', reason: `Serapan anggaran hanya ${p(serapan * 100)} hingga akhir tahun — indikasi keterlambatan kontrak atau pengadaan.`, priority: 'Tinggi', data_ref: 'serapan' });
  if (expSer > 0.975) out.push({ title: 'Lonjakan realisasi belanja triwulan IV', reason: `Realisasi belanja mencapai ${p(expSer * 100)} namun terkonsentrasi di akhir tahun. Periksa kualitas pertanggungjawaban.`, priority: 'Tinggi', data_ref: 'detail' });
  if ((ratios.efektivitas_pad ?? 100) < 92) out.push({ title: 'Target PAD tidak tercapai', reason: `Efektivitas PAD ${p(ratios.efektivitas_pad)} di bawah ambang batas. Potensi over-estimasi target.`, priority: 'Sedang', data_ref: 'ratio:efektivitas_pad' });
  if ((ratios.ketergantungan ?? 0) > 68) out.push({ title: 'Ketergantungan dana transfer tinggi', reason: `${p(ratios.ketergantungan)} pendapatan berasal dari dana transfer pusat. Kemandirian fiskal lemah.`, priority: 'Sedang', data_ref: 'ratio:ketergantungan' });
  if ((ratios.belanja_modal_ratio ?? 100) < 16) out.push({ title: 'Porsi belanja modal relatif kecil', reason: `Belanja modal hanya ${p(ratios.belanja_modal_ratio)} dari total belanja. Periksa prioritas pembangunan.`, priority: 'Rendah', data_ref: 'detail' });
  if (out.length < 2) out.push({ title: 'Profil keuangan dalam batas wajar', reason: 'Tidak ditemukan anomali signifikan. Pantau realisasi triwulanan sebagai kontrol rutin.', priority: 'Rendah', data_ref: 'detail' });
  return out;
}
async function aiRecs(regionName: string, year: number, summary: any, ratios: any) {
  const key = Deno.env.get('OPENROUTER_API_KEY');
  if (!key) return ruleRecs(summary, ratios);
  const model = Deno.env.get('OPENROUTER_CHAT_MODEL') || 'openai/gpt-4o-mini';
  const sys = 'Anda auditor keuangan daerah (BPK). Keluarkan HANYA JSON array berisi 3-6 objek {title, reason, priority, data_ref}. priority salah satu dari "Tinggi"|"Sedang"|"Rendah". data_ref salah satu dari "serapan"|"detail"|"ratio:efektivitas_pad"|"ratio:ketergantungan"|"ratio:efisiensi_belanja". Bahasa Indonesia, ringkas.';
  const usr = `Daerah: ${regionName}, TA ${year}.\nRingkasan (rupiah): ${JSON.stringify(summary)}\nRasio (%): ${JSON.stringify(ratios)}\nIdentifikasi area pemeriksaan prioritas berdasarkan anomali (serapan ekstrem, rasio Perlu Perhatian, ketergantungan transfer, porsi belanja modal kecil).`;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0.3 }),
    });
    const j = await resp.json();
    let txt = j?.choices?.[0]?.message?.content || '';
    txt = txt.replace(/```json|```/g, '').trim();
    const arr = JSON.parse(txt);
    const valid = (Array.isArray(arr) ? arr : []).filter((r) => r && r.title && r.reason && ['Tinggi', 'Sedang', 'Rendah'].includes(r.priority));
    return valid.length ? valid : ruleRecs(summary, ratios);
  } catch (_e) {
    return ruleRecs(summary, ratios);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const baseUrl = Deno.env.get('INSFORGE_BASE_URL');
  const apiKey = Deno.env.get('INSFORGE_API_KEY');
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '') || null;
  if (!token) return json({ error: 'Unauthorized' }, 401);

  // 1) verify caller identity
  const userClient = createClient({ baseUrl, accessToken: token });
  const { data: ud } = await userClient.auth.getCurrentUser();
  const uid = ud?.user?.id;
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  // 2) admin allowlist check (admin client bypasses RLS)
  const admin = createAdminClient({ baseUrl, apiKey });
  const { data: adminRow } = await admin.database.from('app_admin').select('user_id').eq('user_id', uid).maybeSingle?.() ?? { data: null };
  const allow = adminRow || (await admin.database.from('app_admin').select('user_id').eq('user_id', uid)).data?.length;
  if (!allow) return json({ error: 'Forbidden: not an admin' }, 403);

  // 3) parse request
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const { regionSlug, fileBase64, fileName, audited = false } = body;
  if (!regionSlug || !fileBase64) return json({ error: 'regionSlug and fileBase64 are required' }, 400);

  // 4) resolve region
  const { data: regs } = await admin.database.from('region').select('id,name,slug').eq('slug', regionSlug);
  const region = regs?.[0];
  if (!region) return json({ error: `Unknown region: ${regionSlug}` }, 400);

  // 5) parse workbook
  let parsed: any;
  try {
    const bytes = Uint8Array.from(atob(fileBase64), (c) => c.charCodeAt(0));
    const wb = XLSX.read(bytes, { type: 'array' });
    parsed = parseWorkbook(wb);
  } catch (e) {
    await admin.database.from('upload_log').insert([{ region_id: region.id, year: body.year ?? null, file_name: fileName, status: 'Gagal', message: String(e), uploaded_by: uid }]);
    return json({ error: 'Failed to parse workbook', detail: String(e) }, 422);
  }
  const year = +(body.year || parsed.years.current);
  if (!year) return json({ error: 'Could not determine year; pass year' }, 400);
  if (!parsed.derived) return json({ error: 'No LRA sheet found' }, 422);

  // 6) upsert statement_line (replace region/year), summary, ratios, indicators, budget_entry
  await admin.database.from('statement_line').delete().eq('region_id', region.id).eq('year', year);
  const slRows: any[] = [];
  for (const st of Object.keys(parsed.statements))
    for (const l of parsed.statements[st].lines)
      slRows.push({ region_id: region.id, year, statement: st, line_order: l.line_order, label: l.label, ref_code: l.ref_code, level: l.level, kind: l.kind, v0: l.v0, v1: l.v1, v2: l.v2, v3: l.v3, is_audited: !!audited });
  // chunked insert
  for (let i = 0; i < slRows.length; i += 200) await admin.database.from('statement_line').insert(slRows.slice(i, i + 200));

  const s = parsed.derived.summary, r = parsed.derived.ratios;
  await admin.database.from('yearly_summary').upsert([{ region_id: region.id, year, ...s, is_audited: !!audited }], { onConflict: 'region_id,year' });
  await admin.database.from('ratio_result').upsert([{ region_id: region.id, year, ...r }], { onConflict: 'region_id,year' });
  for (const ind of parsed.derived.indicators)
    await admin.database.from('indicator_data').upsert([{ region_id: region.id, year, ...ind }], { onConflict: 'region_id,year,indicator_type' });
  await admin.database.from('budget_entry').delete().eq('region_id', region.id).eq('year', year);
  for (let i = 0; i < parsed.derived.budget_entries.length; i += 200)
    await admin.database.from('budget_entry').insert(parsed.derived.budget_entries.slice(i, i + 200).map((b: any) => ({ region_id: region.id, year, ...b })));

  // 7) regenerate recommendations
  // Use the instant rule-based heuristics here so the import stays fast and the
  // long-lived edge connection doesn't drop (NETWORK_ERROR). The richer AI
  // analysis is run separately via the generate-recommendations function, which
  // the frontend invokes right after a successful import.
  const recs = ruleRecs(s, r);
  await admin.database.from('recommendation').delete().eq('region_id', region.id).eq('year', year);
  if (recs.length) await admin.database.from('recommendation').insert(recs.map((rc: any) => ({ region_id: region.id, year, title: rc.title, reason: rc.reason, priority: rc.priority, data_ref: rc.data_ref || 'detail' })));

  // 8) log
  await admin.database.from('upload_log').insert([{ region_id: region.id, year, file_name: fileName, storage_key: body.storageKey || null, status: 'Sukses', message: `${slRows.length} baris laporan`, uploaded_by: uid }]);

  return json({ ok: true, region: region.slug, year, statementLines: slRows.length, recommendations: recs.length, summary: s, ratios: r });
}
