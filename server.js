const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/config?orgId=xxx&locationId=yyy
app.get('/api/config', async (req, res) => {
  const { orgId, locationId } = req.query;
  if (!orgId) return res.status(400).json({ error: 'orgId richiesto' });

  // Prima cerca config specifica per location
  if (locationId) {
    const { data } = await supabase
      .from('configs')
      .select('*')
      .eq('org_id', orgId)
      .eq('location_id', locationId)
      .eq('active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();
    if (data) return res.json(data);
  }

  // Poi cerca config a livello org (location_id null)
  const { data } = await supabase
    .from('configs')
    .select('*')
    .eq('org_id', orgId)
    .is('location_id', null)
    .eq('active', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (data) return res.json(data);
  return res.json(null);
});

// POST /api/config — salva o aggiorna config
app.post('/api/config', async (req, res) => {
  const { orgId, locationId, youtubeUrl, minDuration } = req.body;
  if (!orgId) return res.status(400).json({ error: 'orgId richiesto' });

  // Cerca se esiste già una config per questa org+location
  let query = supabase.from('configs').select('id')
    .eq('org_id', orgId)
    .eq('active', true);
  if (locationId) query = query.eq('location_id', locationId);
  else query = query.is('location_id', null);

  const { data: existing } = await query.single();

  if (existing) {
    await supabase.from('configs').update({
      youtube_url: youtubeUrl,
      min_duration: minDuration,
      updated_at: new Date().toISOString()
    }).eq('id', existing.id);
  } else {
    await supabase.from('configs').insert({
      org_id: orgId,
      location_id: locationId || null,
      youtube_url: youtubeUrl,
      min_duration: minDuration
    });
  }

  res.json({ success: true });
});

// POST /api/view — registra una visualizzazione
app.post('/api/view', async (req, res) => {
  const { orgId, locationId, youtubeUrl, sessionKey, completed } = req.body;
  if (!orgId) return res.status(400).json({ error: 'orgId richiesto' });

  await supabase.from('views').insert({
    org_id: orgId,
    location_id: locationId || null,
    youtube_url: youtubeUrl,
    session_key: sessionKey || null,
    completed: completed || false
  });

  res.json({ success: true });
});

// GET /api/stats?orgId=xxx&from=2024-01-01&to=2024-12-31
app.get('/api/stats', async (req, res) => {
  const { orgId, from, to } = req.query;
  if (!orgId) return res.status(400).json({ error: 'orgId richiesto' });

  let query = supabase.from('views').select('*').eq('org_id', orgId);
  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to + 'T23:59:59Z');

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const totalViews = data.length;
  const uniqueUsers = new Set(data.filter(v => v.session_key).map(v => v.session_key)).size;
  const completed = data.filter(v => v.completed).length;

  // Raggruppa per video
  const byVideo = {};
  data.forEach(v => {
    if (!byVideo[v.youtube_url]) byVideo[v.youtube_url] = { views: 0, completed: 0 };
    byVideo[v.youtube_url].views++;
    if (v.completed) byVideo[v.youtube_url].completed++;
  });

  res.json({ totalViews, uniqueUsers, completed, byVideo });
});

app.listen(PORT, () => console.log('Server v2 avviato sulla porta ' + PORT));
