// ============================================================================
// generate-recommendations — Admin-only edge function (Deno / InsForge).
//
// Re-runs the AI audit analysis for a region/year using data ALREADY in the
// database (yearly_summary + ratio_result), then replaces the recommendation
// rows. Used by the admin "picu ulang analisis" action (PRD §4 admin flow).
//
// Request (POST, JSON): { regionSlug: string, year: number }
// Deploy: npx @insforge/cli functions deploy generate-recommendations --file functions/generate-recommendations/index.ts
// Secrets: INSFORGE_BASE_URL, INSFORGE_API_KEY, OPENROUTER_API_KEY (optional)
// ============================================================================
import { createClient, createAdminClient } from 'npm:@insforge/sdk';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

function ruleRecs(summary: any, ratios: any) {
  const out: any[] = [];
  const serapan = summary.total_planned_revenue ? summary.total_realized_revenue / summary.total_planned_revenue : 0;
  const expSer = summary.total_planned_expenditure ? summary.total_realized_expenditure / summary.total_planned_expenditure : 0;
  const p = (x: number | null) => (x == null ? '-' : x.toFixed(1) + '%');
  if (serapan < 0.865) out.push({ title: 'Serapan belanja rendah pada akhir tahun', reason: `Serapan anggaran hanya ${p(serapan * 100)} hingga akhir tahun — indikasi keterlambatan kontrak atau pengadaan.`, priority: 'Tinggi', data_ref: 'serapan' });
  if (expSer > 0.975) out.push({ title: 'Lonjakan realisasi belanja triwulan IV', reason: `Realisasi belanja mencapai ${p(expSer * 100)} namun terkonsentrasi di akhir tahun.`, priority: 'Tinggi', data_ref: 'detail' });
  if ((ratios.efektivitas_pad ?? 100) < 92) out.push({ title: 'Target PAD tidak tercapai', reason: `Efektivitas PAD ${p(ratios.efektivitas_pad)} di bawah ambang batas.`, priority: 'Sedang', data_ref: 'ratio:efektivitas_pad' });
  if ((ratios.ketergantungan ?? 0) > 68) out.push({ title: 'Ketergantungan dana transfer tinggi', reason: `${p(ratios.ketergantungan)} pendapatan berasal dari dana transfer pusat.`, priority: 'Sedang', data_ref: 'ratio:ketergantungan' });
  if ((ratios.belanja_modal_ratio ?? 100) < 16) out.push({ title: 'Porsi belanja modal relatif kecil', reason: `Belanja modal hanya ${p(ratios.belanja_modal_ratio)} dari total belanja.`, priority: 'Rendah', data_ref: 'detail' });
  if (out.length < 2) out.push({ title: 'Profil keuangan dalam batas wajar', reason: 'Tidak ditemukan anomali signifikan. Pantau realisasi triwulanan.', priority: 'Rendah', data_ref: 'detail' });
  return out;
}
async function aiRecs(regionName: string, year: number, summary: any, ratios: any) {
  const key = Deno.env.get('OPENROUTER_API_KEY');
  if (!key) return ruleRecs(summary, ratios);
  const model = Deno.env.get('OPENROUTER_CHAT_MODEL') || 'openai/gpt-4o-mini';
  const sys = 'Anda auditor keuangan daerah (BPK). Keluarkan HANYA JSON array berisi 3-6 objek {title, reason, priority, data_ref}. priority: "Tinggi"|"Sedang"|"Rendah". data_ref: "serapan"|"detail"|"ratio:efektivitas_pad"|"ratio:ketergantungan"|"ratio:efisiensi_belanja". Bahasa Indonesia, ringkas.';
  const usr = `Daerah: ${regionName}, TA ${year}.\nRingkasan (rupiah): ${JSON.stringify(summary)}\nRasio (%): ${JSON.stringify(ratios)}`;
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], temperature: 0.3 }),
    });
    const j = await resp.json();
    let txt = (j?.choices?.[0]?.message?.content || '').replace(/```json|```/g, '').trim();
    const arr = JSON.parse(txt);
    const valid = (Array.isArray(arr) ? arr : []).filter((r) => r && r.title && r.reason && ['Tinggi', 'Sedang', 'Rendah'].includes(r.priority));
    return valid.length ? valid : ruleRecs(summary, ratios);
  } catch { return ruleRecs(summary, ratios); }
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const baseUrl = Deno.env.get('INSFORGE_BASE_URL');
  const apiKey = Deno.env.get('INSFORGE_API_KEY');
  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '') || null;
  if (!token) return json({ error: 'Unauthorized' }, 401);

  const userClient = createClient({ baseUrl, accessToken: token });
  const { data: ud } = await userClient.auth.getCurrentUser();
  const uid = ud?.user?.id;
  if (!uid) return json({ error: 'Unauthorized' }, 401);

  const admin = createAdminClient({ baseUrl, apiKey });
  const { data: adminRows } = await admin.database.from('app_admin').select('user_id').eq('user_id', uid);
  if (!adminRows?.length) return json({ error: 'Forbidden: not an admin' }, 403);

  let body: any; try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { regionSlug, year } = body;
  if (!regionSlug || !year) return json({ error: 'regionSlug and year are required' }, 400);

  const { data: regs } = await admin.database.from('region').select('id,name,slug').eq('slug', regionSlug);
  const region = regs?.[0];
  if (!region) return json({ error: `Unknown region: ${regionSlug}` }, 400);

  const { data: sumRows } = await admin.database.from('yearly_summary').select('*').eq('region_id', region.id).eq('year', year);
  const { data: ratRows } = await admin.database.from('ratio_result').select('*').eq('region_id', region.id).eq('year', year);
  if (!sumRows?.length) return json({ error: 'No yearly_summary for this region/year; import data first' }, 404);

  const recs = await aiRecs(region.name, year, sumRows[0], ratRows?.[0] || {});
  await admin.database.from('recommendation').delete().eq('region_id', region.id).eq('year', year);
  if (recs.length) await admin.database.from('recommendation').insert(recs.map((rc: any) => ({ region_id: region.id, year, title: rc.title, reason: rc.reason, priority: rc.priority, data_ref: rc.data_ref || 'detail' })));

  return json({ ok: true, region: region.slug, year, recommendations: recs.length });
}
