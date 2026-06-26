#!/usr/bin/env node
// ============================================================================
// seed-from-xlsx.mjs — Parse a BPK .xlsx and emit idempotent SQL that upserts
// one region/year into the InsForge tables. Use this to seed audited data
// without going through the admin UI.
//
// Usage:
//   node scripts/seed-from-xlsx.mjs <file.xlsx> --region <slug> [--year <YYYY>] [--audited] > out.sql
//   node scripts/seed-from-xlsx.mjs data/samples/Kabupaten_Bima_2025.xlsx --region bima --year 2025 --audited > data/seed/bima-2025.sql
//
// Then apply with:
//   npx @insforge/cli db query "$(cat data/seed/bima-2025.sql)"
// ============================================================================
import { readFileSync } from 'node:fs';
import * as XLSX from '../node_modules/xlsx/xlsx.mjs';
import { parseWorkbook } from './lib/parse-statements.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i !== -1 ? (args[i + 1]?.startsWith('--') ? true : args[i + 1]) : d; };
const region = opt('region');
const audited = args.includes('--audited');
if (!file || !region) {
  console.error('Usage: node scripts/seed-from-xlsx.mjs <file.xlsx> --region <slug> [--year YYYY] [--audited]');
  process.exit(1);
}

const wb = XLSX.read(readFileSync(file), { type: 'buffer' });
const parsed = parseWorkbook(XLSX, wb);
const year = +(opt('year', parsed.years.current) || parsed.years.current);
if (!year) { console.error('Could not determine year; pass --year'); process.exit(1); }

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const out = [];
out.push(`-- Seed ${region} TA ${year} from ${file.split('/').pop()} (audited=${audited})`);
out.push('BEGIN;');
out.push(`-- resolve region id`);
out.push(`DO $$ DECLARE rid INT; BEGIN`);
out.push(`  SELECT id INTO rid FROM public.region WHERE slug = ${q(region)};`);
out.push(`  IF rid IS NULL THEN RAISE EXCEPTION 'unknown region slug: %', ${q(region)}; END IF;`);

// --- statement_line: replace existing for this region/year ---
out.push(`  DELETE FROM public.statement_line WHERE region_id = rid AND year = ${year};`);
for (const st of Object.keys(parsed.statements)) {
  for (const l of parsed.statements[st].lines) {
    out.push(`  INSERT INTO public.statement_line (region_id,year,statement,line_order,label,ref_code,level,kind,v0,v1,v2,v3,is_audited) VALUES (rid,${year},${q(st)},${l.line_order},${q(l.label)},${q(l.ref_code)},${l.level},${q(l.kind)},${q(l.v0)},${q(l.v1)},${q(l.v2)},${q(l.v3)},${audited});`);
  }
}

// --- yearly_summary ---
const s = parsed.derived.summary;
out.push(`  INSERT INTO public.yearly_summary (region_id,year,total_planned_revenue,total_realized_revenue,total_planned_expenditure,total_realized_expenditure,net_financing,pad_planned,pad_realized,transfer_realized,bd_pegawai,bd_barang,bd_modal,bd_lain,is_audited)
  VALUES (rid,${year},${s.total_planned_revenue},${s.total_realized_revenue},${s.total_planned_expenditure},${s.total_realized_expenditure},${s.net_financing},${s.pad_planned},${s.pad_realized},${s.transfer_realized},${s.bd_pegawai},${s.bd_barang},${s.bd_modal},${s.bd_lain},${audited})
  ON CONFLICT (region_id,year) DO UPDATE SET total_planned_revenue=EXCLUDED.total_planned_revenue,total_realized_revenue=EXCLUDED.total_realized_revenue,total_planned_expenditure=EXCLUDED.total_planned_expenditure,total_realized_expenditure=EXCLUDED.total_realized_expenditure,net_financing=EXCLUDED.net_financing,pad_planned=EXCLUDED.pad_planned,pad_realized=EXCLUDED.pad_realized,transfer_realized=EXCLUDED.transfer_realized,bd_pegawai=EXCLUDED.bd_pegawai,bd_barang=EXCLUDED.bd_barang,bd_modal=EXCLUDED.bd_modal,bd_lain=EXCLUDED.bd_lain,is_audited=EXCLUDED.is_audited,updated_at=now();`);

// --- ratio_result ---
const r = parsed.derived.ratios;
out.push(`  INSERT INTO public.ratio_result (region_id,year,ddf,rkk,efektivitas_pad,efisiensi_belanja,belanja_modal_ratio,ketergantungan)
  VALUES (rid,${year},${q(r.ddf)},${q(r.rkk)},${q(r.efektivitas_pad)},${q(r.efisiensi_belanja)},${q(r.belanja_modal_ratio)},${q(r.ketergantungan)})
  ON CONFLICT (region_id,year) DO UPDATE SET ddf=EXCLUDED.ddf,rkk=EXCLUDED.rkk,efektivitas_pad=EXCLUDED.efektivitas_pad,efisiensi_belanja=EXCLUDED.efisiensi_belanja,belanja_modal_ratio=EXCLUDED.belanja_modal_ratio,ketergantungan=EXCLUDED.ketergantungan,updated_at=now();`);

// --- indicator_data ---
for (const ind of parsed.derived.indicators) {
  out.push(`  INSERT INTO public.indicator_data (region_id,year,indicator_type,value) VALUES (rid,${year},${q(ind.indicator_type)},${q(ind.value)})
  ON CONFLICT (region_id,year,indicator_type) DO UPDATE SET value=EXCLUDED.value;`);
}

// --- budget_entry: replace existing ---
out.push(`  DELETE FROM public.budget_entry WHERE region_id = rid AND year = ${year};`);
for (const b of parsed.derived.budget_entries) {
  out.push(`  INSERT INTO public.budget_entry (region_id,year,category,sub_category,ref_code,level,planned_amount,realized_amount) VALUES (rid,${year},${q(b.category)},${q(b.sub_category)},${q(b.ref_code)},${b.level},${b.planned_amount},${b.realized_amount});`);
}

out.push(`END $$;`);
out.push('COMMIT;');
process.stdout.write(out.join('\n') + '\n');
console.error(`✓ Seed SQL for ${region} TA ${year}: ${Object.values(parsed.statements).reduce((n, s) => n + s.lines.length, 0)} statement lines, summary + 6 ratios + ${parsed.derived.budget_entries.length} budget entries.`);
