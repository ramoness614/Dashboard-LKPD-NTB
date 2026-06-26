// ============================================================================
// parse-statements.mjs — Parse a BPK-format APBD .xlsx (6 sheets:
// LRA, LPSAL, Neraca, LO, LAK, LPE) into normalized records ready for the
// InsForge tables: statement_line, budget_entry, yearly_summary, ratio_result,
// indicator_data.
//
// Pure (no I/O beyond reading a workbook object), so the SAME code runs in:
//   - the Node seed CLI (scripts/seed-from-xlsx.mjs)
//   - the InsForge edge function (functions/import-report) via SheetJS
//
// Values are kept in FULL RUPIAH (as in the source file). The frontend/data
// client scales to miliar/triliun for display.
// ============================================================================

export const STATEMENTS = ['LRA', 'LPSAL', 'Neraca', 'LO', 'LAK', 'LPE'];

// Canonical column layout per statement (mirrors the frontend's rawBima shape).
export const STATEMENT_COLUMNS = {
  LRA:    ['Anggaran', 'Realisasi', '%', 'Prev'],
  LPSAL:  ['Tahun', 'Prev'],
  Neraca: ['Tahun', 'Prev'],
  LO:     ['Tahun', 'Prev', 'Naik/(Turun)', '%'],
  LAK:    ['Tahun', 'Prev'],
  LPE:    ['Tahun', 'Prev'],
};

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^0-9.,()-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  if (!s || s === '-' || s === '()') return null;
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[()]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
};
const isUpper = (s) => /[A-Z]/.test(s) && s === s.toUpperCase();
const refDepth = (ref) => (ref ? String(ref).trim().split('.').filter(Boolean).length : 0);
const norm = (s) => String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();

// Read a worksheet into a dense row matrix of cell values.
function sheetMatrix(XLSX, ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
  return rows;
}

// Locate the header row (contains "URAIAN") and classify value columns.
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const row = rows[r] || [];
    const idx = row.findIndex((c) => norm(c) === 'URAIAN');
    if (idx !== -1) return { headerRow: r, labelCol: idx, headerCells: row };
  }
  // fallback: first row whose col 0 is text and col >0 has a year/keyword
  return { headerRow: 0, labelCol: 0, headerCells: rows[0] || [] };
}

// From the header cells decide the role of each column.
function classifyColumns(headerCells) {
  const cols = [];
  headerCells.forEach((h, i) => {
    const t = norm(h);
    if (!t) return;
    if (/REF/.test(t)) { cols.push({ i, role: 'ref' }); return; }
    if (t === '%') { cols.push({ i, role: 'pct' }); return; }
    const year = (t.match(/(20\d\d)/) || [])[1];
    if (/ANGGARAN/.test(t)) { cols.push({ i, role: 'anggaran', year: year && +year }); return; }
    if (/REALISASI|REALISAS/.test(t)) { cols.push({ i, role: 'realisasi', year: year && +year }); return; }
    if (year) { cols.push({ i, role: 'year', year: +year }); return; }
    if (/NAIK|TURUN/.test(t)) { cols.push({ i, role: 'delta' }); return; }
  });
  return cols;
}

function detectYears(rows, cols, headerRow) {
  const years = new Set();
  // 1) Trust years declared in the header columns (most reliable).
  cols.forEach((c) => c.year && years.add(c.year));
  // 2) Otherwise scan ONLY the title block above the header, and only string
  //    cells (numeric data rows can contain 20xx-like digit runs).
  if (years.size < 2) {
    for (let r = 0; r < headerRow; r++) {
      for (const c of rows[r] || []) {
        if (typeof c !== 'string') continue;
        const m = c.toUpperCase().match(/\b(20\d\d)\b/g);
        if (m) m.forEach((y) => years.add(+y));
      }
    }
  }
  const sorted = [...years].sort((a, b) => b - a);
  return { current: sorted[0] || null, prev: sorted[1] || (sorted[0] ? sorted[0] - 1 : null) };
}

// Parse one statement sheet -> { lines: [...], years }
export function parseStatementSheet(XLSX, ws, statement) {
  const rows = sheetMatrix(XLSX, ws);
  const { headerRow, labelCol, headerCells } = findHeader(rows);
  const cols = classifyColumns(headerCells);
  const { current, prev } = detectYears(rows, cols, headerRow);

  const refCol = (cols.find((c) => c.role === 'ref') || {}).i;
  const anggaranCol = (cols.find((c) => c.role === 'anggaran') || {}).i;
  const realisasiCurCol = (cols.find((c) => c.role === 'realisasi' && (!c.year || c.year === current)) || cols.find((c) => c.role === 'realisasi') || {}).i;
  const curYearCol = (cols.find((c) => c.role === 'year' && c.year === current) || {}).i;
  const prevCol = (cols.find((c) => (c.role === 'year' || c.role === 'realisasi') && c.year === prev) || {}).i;

  // baseline ref depth (for level derivation)
  let baseDepth = Infinity;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const ref = refCol != null ? rows[r]?.[refCol] : null;
    const d = refDepth(ref);
    if (d) baseDepth = Math.min(baseDepth, d);
  }
  if (!Number.isFinite(baseDepth)) baseDepth = 0;

  const lines = [];
  let order = 0;
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const label = row[labelCol];
    if (label == null || String(label).trim() === '') continue;
    const ls = String(label).trim();
    // stop at the CALK footnote / signature block
    if (/^Catatan atas Laporan Keuangan/i.test(ls) || /BUPATI|WALIKOTA|TTD/i.test(ls)) break;

    const ref = refCol != null ? row[refCol] : null;
    const d = refDepth(ref);
    let level, kind;
    if (d) {
      level = Math.max(0, Math.min(2, d - baseDepth));
    } else {
      level = isUpper(ls) ? 0 : 2;
    }
    kind = level === 0 ? 't' : level === 1 ? 's' : 'i';

    // map raw cells -> canonical v0..v3
    let v0 = null, v1 = null, v2 = null, v3 = null;
    if (statement === 'LRA') {
      v0 = anggaranCol != null ? num(row[anggaranCol]) : null;          // Anggaran
      v1 = realisasiCurCol != null ? num(row[realisasiCurCol]) : null;  // Realisasi (current)
      v2 = null;                                                        // % (computed)
      v3 = prevCol != null ? num(row[prevCol]) : null;                  // prev-year realisasi
    } else if (statement === 'LO') {
      v0 = curYearCol != null ? num(row[curYearCol]) : null;
      v1 = prevCol != null ? num(row[prevCol]) : null;
      // v2 (naik/turun) and v3 (%) computed by the data client
    } else {
      v0 = curYearCol != null ? num(row[curYearCol]) : null;
      v1 = prevCol != null ? num(row[prevCol]) : null;
    }

    // skip fully-empty numeric rows that are also not headers
    if (v0 == null && v1 == null && v3 == null && kind === 'i') continue;

    lines.push({
      statement, line_order: order++, label: ls,
      ref_code: ref ? String(ref).trim() : null,
      level, kind, v0, v1, v2, v3,
    });
  }
  return { statement, years: { current, prev }, lines };
}

// Match an LRA line by normalized label keywords.
function pick(lines, ...keys) {
  const K = keys.map(norm);
  return lines.find((l) => { const t = norm(l.label); return K.every((k) => t.includes(k)); });
}

// Derive yearly_summary + budget_entry + ratio_result + indicator_data from LRA.
export function deriveFromLRA(lraLines) {
  const L = lraLines;
  const val = (line, f) => (line && line[f] != null ? line[f] : 0);

  const pend       = pick(L, 'PENDAPATAN DAERAH');
  const pad        = pick(L, 'PENDAPATAN ASLI DAERAH');
  const transfer   = pick(L, 'PENDAPATAN TRANSFER');
  const belanja    = pick(L, 'BELANJA DAERAH');
  const belPegawai = pick(L, 'BELANJA PEGAWAI') || pick(L, 'PEGAWAI');
  const belBarang  = pick(L, 'BARANG DAN JASA');
  const belModal   = pick(L, 'BELANJA MODAL') && pick(L, 'BELANJA MODAL').kind === 't'
                      ? pick(L, 'BELANJA MODAL')
                      : L.find((l) => norm(l.label) === 'BELANJA MODAL');
  const pembiayaan = pick(L, 'PEMBIAYAAN DAERAH NETTO') || pick(L, 'PEMBIAYAAN DAERAH');

  const total_planned_revenue      = val(pend, 'v0');
  const total_realized_revenue     = val(pend, 'v1');
  const total_planned_expenditure  = val(belanja, 'v0');
  const total_realized_expenditure = val(belanja, 'v1');
  const net_financing              = val(pembiayaan, 'v1');
  const pad_planned                = val(pad, 'v0');
  const pad_realized               = val(pad, 'v1');
  const transfer_realized          = val(transfer, 'v1');
  const bd_pegawai                 = val(belPegawai, 'v1');
  const bd_barang                  = val(belBarang, 'v1');
  const bd_modal                   = val(belModal, 'v1');
  const bd_lain = Math.max(0, total_realized_expenditure - bd_pegawai - bd_barang - bd_modal);

  const summary = {
    total_planned_revenue, total_realized_revenue,
    total_planned_expenditure, total_realized_expenditure, net_financing,
    pad_planned, pad_realized, transfer_realized,
    bd_pegawai, bd_barang, bd_modal, bd_lain,
  };

  const pct = (a, b) => (b ? (a / b) * 100 : null);
  const ratios = {
    ddf: pct(pad_realized, total_realized_revenue),
    rkk: pct(pad_realized, transfer_realized),
    efektivitas_pad: pct(pad_realized, pad_planned),
    efisiensi_belanja: pct(total_realized_expenditure, total_realized_revenue),
    belanja_modal_ratio: pct(bd_modal, total_realized_expenditure),
    ketergantungan: pct(transfer_realized, total_planned_revenue),
  };

  const serapan = pct(total_realized_revenue, total_planned_revenue);
  const indicators = [
    { indicator_type: 'serapan', value: serapan },
    { indicator_type: 'deviasi', value: pct(total_planned_expenditure - total_realized_expenditure, total_planned_expenditure) },
  ];

  // budget_entry rows: top-level + section lines from LRA (pendapatan/belanja/pembiayaan)
  const catOf = (line) => {
    const t = norm(line.label);
    if (t.includes('PENDAPATAN')) return 'pendapatan';
    if (t.includes('BELANJA')) return 'belanja';
    if (t.includes('PEMBIAYAAN') || t.includes('SILPA') || t.includes('SURPLUS')) return 'pembiayaan';
    return null;
  };
  const budget_entries = L
    .filter((l) => l.level <= 1 && (l.v0 != null || l.v1 != null))
    .map((l) => {
      const category = catOf(l);
      if (!category) return null;
      return {
        category, sub_category: l.label, ref_code: l.ref_code, level: l.level,
        planned_amount: l.v0 || 0, realized_amount: l.v1 || 0,
      };
    })
    .filter(Boolean);

  return { summary, ratios, indicators, budget_entries };
}

// Top-level: parse a whole workbook into everything needed for one region/year.
export function parseWorkbook(XLSX, wb) {
  const out = { statements: {}, years: { current: null, prev: null } };
  for (const name of wb.SheetNames) {
    const canon = STATEMENTS.find((s) => s.toLowerCase() === name.trim().toLowerCase());
    if (!canon) continue; // skips "LRA salah" and any extra sheets
    if (out.statements[canon]) continue; // first match wins
    const parsed = parseStatementSheet(XLSX, wb.Sheets[name], canon);
    out.statements[canon] = parsed;
    if (canon === 'LRA') out.years = parsed.years;
  }
  if (!out.years.current) {
    const any = Object.values(out.statements)[0];
    if (any) out.years = any.years;
  }
  const lra = out.statements.LRA;
  out.derived = lra ? deriveFromLRA(lra.lines) : null;
  return out;
}
