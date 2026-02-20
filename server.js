const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function getC4WContext(sk) {
  const url = `https://volare.cloud4wi.com/controlpanel/1.0/bridge/sessions/${sk}`;
  const response = await fetch(url);
  const json = await response.json();
  if (json.status !== 'success') return null;
  return json.data;
}

app.get('/api/config/journey', async (req, res) => {
  const { sk } = req.query;
  if (!sk) return res.json({ skip: true });
  let context;
  try { context = await getC4WContext(sk); } catch (e) { return res.json({ skip: true }); }
  if (!context) return res.json({ skip: true });

  const tenantId = context.tenant?.tenant_id;
  const wifiareaId = context.wifiarea?.wifiarea_id || null;
  const hotspotName = context.hotspot?.name || null;
  const customerId = context.customer?.id || null;
  const customerEmail = context.customer?.email || null;

  if (!tenantId) return res.json({ skip: true });

  let config = null;
  if (wifiareaId) {
    const { data } = await supabase.from('configs').select('*').eq('tenant_id', tenantId).eq('wifiarea_id', wifiareaId).maybeSingle();
    if (data) config = data;
  }
  if (!config) {
    const { data } = await supabase.from('configs').select('*').eq('tenant_id', tenantId).is('wifiarea_id', null).maybeSingle();
    if (data) config = data;
  }
  if (!config) return res.json({ skip: true });

  res.json({
    skip: false,
    youtubeUrl: config.youtube_url,
    minDuration: config.min_duration,
    videoLabel: config.video_label || null,
    context: { tenantId, wifiareaId, hotspotName, customerId, customerEmail }
  });
});

app.get('/api/configs', async (req, res) => {
  const { tenant_id } = req.query;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id richiesto' });
  const { data, error } = await supabase.from('configs').select('*').eq('tenant_id', tenant_id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/config', async (req, res) => {
  const { tenant_id, wifiarea_id, label, video_label, youtube_url, min_duration } = req.body;
  if (!tenant_id || !youtube_url) return res.status(400).json({ error: 'Dati mancanti' });

  const wId = wifiarea_id || null;
  let existsQuery = supabase.from('configs').select('id').eq('tenant_id', tenant_id);
  existsQuery = wId ? existsQuery.eq('wifiarea_id', wId) : existsQuery.is('wifiarea_id', null);
  const { data: existing } = await existsQuery.maybeSingle();

  const payload = {
    label: label || null,
    video_label: video_label || null,
    youtube_url,
    min_duration: parseInt(min_duration) || 10
  };

  let result;
  if (existing) {
    result = await supabase.from('configs').update(payload).eq('id', existing.id).select().single();
  } else {
    result = await supabase.from('configs').insert({ tenant_id, wifiarea_id: wId, ...payload }).select().single();
  }

  if (result.error) return res.status(500).json({ error: result.error.message });
  res.json({ success: true, data: result.data });
});

app.delete('/api/config/:id', async (req, res) => {
  const { error } = await supabase.from('configs').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/view', async (req, res) => {
  const { tenant_id, wifiarea_id, hotspot_name, customer_id, customer_email, youtube_url, video_label, seconds_watched, completed } = req.body;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id richiesto' });
  const { error } = await supabase.from('views').insert({
    tenant_id,
    wifiarea_id: wifiarea_id || null,
    hotspot_name: hotspot_name || null,
    customer_id: customer_id || null,
    customer_email: customer_email || null,
    youtube_url: youtube_url || null,
    video_label: video_label || null,
    seconds_watched: parseInt(seconds_watched) || 0,
    completed: !!completed
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/stats', async (req, res) => {
  const { tenant_id, from, to } = req.query;
  if (!tenant_id) return res.status(400).json({ error: 'tenant_id richiesto' });

  let query = supabase.from('views').select('*').eq('tenant_id', tenant_id);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to + 'T23:59:59');

  const [{ data, error }, { data: configs }] = await Promise.all([
    query,
    supabase.from('configs').select('youtube_url, video_label').eq('tenant_id', tenant_id)
  ]);
  if (error) return res.status(500).json({ error: error.message });

  const configLabelMap = {};
  (configs || []).forEach(c => { if (c.youtube_url && c.video_label) configLabelMap[c.youtube_url] = c.video_label; });

  const rows = data || [];
  const totalViews = rows.length;
  const completedViews = rows.filter(v => v.completed).length;
  const uniqueCustomers = new Set(rows.filter(v => v.customer_id).map(v => v.customer_id)).size;

  const byVideoMap = {};
  rows.forEach(v => {
    const key = v.youtube_url || 'N/A';
    if (!byVideoMap[key]) byVideoMap[key] = { youtube_url: key, video_label: v.video_label || configLabelMap[key] || null, total: 0, completed: 0, customers: new Set() };
    if (!byVideoMap[key].video_label) byVideoMap[key].video_label = v.video_label || configLabelMap[key] || null;
    byVideoMap[key].total++;
    if (v.completed) byVideoMap[key].completed++;
    if (v.customer_id) byVideoMap[key].customers.add(v.customer_id);
  });

  const byLocationMap = {};
  rows.forEach(v => {
    const key = v.wifiarea_id || 'N/A';
    if (!byLocationMap[key]) byLocationMap[key] = { wifiarea_id: key, name: v.hotspot_name || key, total: 0, completed: 0 };
    byLocationMap[key].total++;
    if (v.completed) byLocationMap[key].completed++;
  });

  res.json({
    total_views: totalViews,
    completed_views: completedViews,
    unique_customers: uniqueCustomers,
    by_video: Object.values(byVideoMap).map(v => ({
      youtube_url: v.youtube_url, video_label: v.video_label, total: v.total, completed: v.completed, unique_customers: v.customers.size
    })),
    by_location: Object.values(byLocationMap)
  });
});

app.get('/api/locations', async (req, res) => {
  try {
    const response = await fetch(
      `https://api.cloud4wi.com/v1/organizations/${process.env.C4W_ORG_ID}/locations?size=200`,
      { headers: { 'Authorization': `Bearer ${process.env.C4W_API_KEY}` } }
    );
    const json = await response.json();
    const locations = (json.locations || []).map(l => ({
      id: l.id,
      name: l.name
    }));
    res.json(locations);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/debug/locations', async (req, res) => {
  try {
    const authResponse = await fetch('https://explore.cloud4wi.com/v1/sts/login/services', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({
        clientKey: process.env.C4W_API_KEY,
        clientSecret: process.env.C4W_API_SECRET
      })
    });
    const authJson = await authResponse.json();
    const token = authJson.token;

    if (!token) return res.send(`<pre>AUTH FALLITA (${authResponse.status}):\n${JSON.stringify(authJson)}</pre>`);

    const locResponse = await fetch(
`https://explore.cloud4wi.com/v1/organizations/${process.env.C4W_ORG_ID}/locations?size=200`
      { headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' } }
    );
    const locText = await locResponse.text();
    res.send(`<pre>AUTH OK\n\nLOCATIONS (${locResponse.status}):\n${locText}</pre>`);
  } catch (e) {
    res.send(`<pre>ERRORE: ${e.message}</pre>`);
  }
});



app.listen(PORT, () => console.log('Server avviato sulla porta ' + PORT));
