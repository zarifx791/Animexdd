const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'animexd-media';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

app.use(express.json({ limit: '2mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 *  60 * 60 * 1000 }
}));

const ADMIN_ROUTE = process.env.ADMIN_ROUTE || '/manage-animexd-7f3c9b2d';
app.get('/admin.html', (_req, res) => res.status(404).send('Not found'));
app.get(ADMIN_ROUTE, (_req, res) => res.sendFile(path.join(__dirname, 'private-admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

const adminOnly = (req, res, next) =>
  req.session && req.session.isAdmin ? next() : res.status(401).json({ error: 'Please log in as admin.' });

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Video file only (MP4, WEBM, MOV).'));
  }
});
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 9 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif|avif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Choose JPG, PNG, WEBP, GIF or AVIF images only.'));
  }
});

function extOf(name) {
  return path.extname(name || '').slice(0, 10).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
}
async function uploadObject(file, folder) {
  const objectPath = folder + '/' + crypto.randomUUID() + extOf(file.originalname);
  const { error } = await supabase.storage.from(BUCKET).upload(objectPath, file.buffer, {
    contentType: file.mimetype || 'application/octet-stream',
    upsert: false
  });
  if (error) throw error;
  return 'storage://' + objectPath;
}
async function publicUrl(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('storage://')) return value || '';
  const objectPath = value.slice('storage://'.length);
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(objectPath, 60 * 60);
  if (error) {
    console.error('Could not sign storage URL:', error.message);
    return '';
  }
  return data.signedUrl;
}
async function presentAnime(row) {
  const shots = Array.isArray(row.screenshots) ? row.screenshots : [];
  return {
    id: row.id, title: row.title, poster: await publicUrl(row.poster),
    overview: row.overview || '', year: row.year || '', studio: row.studio || '',
    writer: row.writer || '', genre: row.genre || '', language: row.language || '',
    screenshots: await Promise.all(shots.map(publicUrl)), createdAt: row.created_at
  };
}
async function presentEpisode(row) {
  const url = await publicUrl(row.video_url);
  return {
    id: row.id, title: row.title, description: row.description || '',
    seriesId: row.series_id || '', videoUrl: url, downloadUrl: url,
    videoProvider: row.video_provider || 'direct', videoMode: row.video_mode || 'direct',
    published: row.published, createdAt: row.created_at
  };
}
async function getAnimeRows() {
  const { data, error } = await supabase.from('anime_series').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
async function getEpisodeRows(publishedOnly = false) {
  let query = supabase.from('episodes').select('*').order('created_at', { ascending: false });
  if (publishedOnly) query = query.eq('published', true);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}
const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

app.get('/api/anime', async (_req, res, next) => {
  try { res.json(await Promise.all((await getAnimeRows()).map(presentAnime))); }
  catch (e) { next(e); }
});
app.get('/api/anime/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('anime_series').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Anime not found.' });
    const { data: eps, error: epError } = await supabase.from('episodes').select('*')
      .eq('series_id', req.params.id).eq('published', true).order('created_at', { ascending: false });
    if (epError) throw epError;
    res.json({ ...(await presentAnime(data)), episodes: await Promise.all((eps || []).map(presentEpisode)) });
  } catch (e) { next(e); }
});

app.post('/api/admin/anime', adminOnly,
  imageUpload.fields([{ name: 'posterFile', maxCount: 1 }, { name: 'screenshotFiles', maxCount: 8 }]),
  async (req, res, next) => {
    try {
      const title = String(req.body.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Anime title is required.' });
      const id = newId();
      let poster = String(req.body.poster || '').trim().slice(0, 1000);
      if (req.files?.posterFile?.[0]) poster = await uploadObject(req.files.posterFile[0], 'anime/' + id + '/poster');
      const uploadedShots = await Promise.all((req.files?.screenshotFiles || []).map(f => uploadObject(f, 'anime/' + id + '/screenshots')));
      const typedShots = String(req.body.screenshots || '').split(/\n|,/).map(x => x.trim()).filter(Boolean);
      const row = {
        id, title: title.slice(0, 160), poster,
        overview: String(req.body.overview || '').trim().slice(0, 3000),
        year: String(req.body.year || '').slice(0, 10),
        studio: String(req.body.studio || '').trim().slice(0, 160),
        writer: String(req.body.writer || '').trim().slice(0, 160),
        genre: String(req.body.genre || '').trim().slice(0, 300),
        language: String(req.body.language || '').trim().slice(0, 100),
        screenshots: [...uploadedShots, ...typedShots].slice(0, 8)
      };
      const { data, error } = await supabase.from('anime_series').insert(row).select().single();
      if (error) throw error;
      res.json(await presentAnime(data));
    } catch (e) { next(e); }
  });

app.patch('/api/admin/anime/:id', adminOnly, async (req, res, next) => {
  try {
    const allowed = ['title','overview','year','studio','writer','genre','language','poster'];
    const update = {};
    for (const key of allowed) {
      if (typeof req.body[key] === 'string') update[key] = req.body[key].trim().slice(0, key === 'overview' ? 3000 : key === 'genre' ? 300 : key === 'language' ? 100 : 160);
    }
    if (update.title !== undefined && !update.title) return res.status(400).json({ error: 'Anime title is required.' });
    const { data, error } = await supabase.from('anime_series').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Anime not found.' });
    res.json(await presentAnime(data));
  } catch (e) { next(e); }
});

app.delete('/api/admin/anime/:id', adminOnly, async (req, res, next) => {
  try {
    const { data, error } = await supabase.from('anime_series').delete().eq('id', req.params.id).select('id');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Anime not found.' });
    // Schema uses ON DELETE SET NULL, so episodes remain as standalone items.
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/episodes', async (_req, res, next) => {
  try { res.json(await Promise.all((await getEpisodeRows(true)).map(presentEpisode))); }
  catch (e) { next(e); }
});
app.post('/api/admin/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'Admin password is not configured. Set ADMIN_PASSWORD in the hosting environment.' });
  if (req.body && req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Could not save admin session. Please try again.' });
      res.json({ ok: true });
    });
  }
  res.status(401).json({ error: 'Wrong password.' });
});
app.post('/api/admin/logout', adminOnly, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/episodes', adminOnly, async (_req, res, next) => {
  try { res.json(await Promise.all((await getEpisodeRows(false)).map(presentEpisode))); }
  catch (e) { next(e); }
});
app.post('/api/admin/episodes', adminOnly, videoUpload.single('video'), async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Episode title is required.' });
    let videoUrl = String(req.body.videoUrl || '').trim();
    let provider = String(req.body.videoProvider || 'direct').slice(0, 30);
    let mode = req.body.videoMode === 'embed' ? 'embed' : 'direct';
    if (req.file) {
      videoUrl = await uploadObject(req.file, 'episodes/' + newId());
      provider = 'supabase-storage';
      mode = 'direct';
    }
    if (!videoUrl) return res.status(400).json({ error: 'Upload a video or provide a video URL.' });
    if (!videoUrl.startsWith('storage://') && !videoUrl.startsWith('https://'))
      return res.status(400).json({ error: 'Use a secure HTTPS video or embed URL.' });
    const row = {
      id: newId(), title: title.slice(0, 160),
      description: String(req.body.description || '').slice(0, 2000),
      series_id: String(req.body.seriesId || '').trim().slice(0, 100) || null,
      video_url: videoUrl, video_provider: provider, video_mode: mode,
      published: req.body.published !== 'false'
    };
    const { data, error } = await supabase.from('episodes').insert(row).select().single();
    if (error) throw error;
    res.json(await presentEpisode(data));
  } catch (e) { next(e); }
});
app.patch('/api/admin/episodes/:id', adminOnly, async (req, res, next) => {
  try {
    const update = {};
    if (typeof req.body.published === 'boolean') update.published = req.body.published;
    if (typeof req.body.title === 'string') {
      const title = req.body.title.trim().slice(0, 160);
      if (!title) return res.status(400).json({ error: 'Episode title is required.' });
      update.title = title;
    }
    if (typeof req.body.description === 'string') update.description = req.body.description.trim().slice(0, 2000);
    if (typeof req.body.videoUrl === 'string') {
      const videoUrl = req.body.videoUrl.trim();
      if (!videoUrl.startsWith('https://')) return res.status(400).json({ error: 'Use a secure HTTPS video or embed URL.' });
      update.video_url = videoUrl;
      update.video_provider = String(req.body.videoProvider || 'other').slice(0, 30);
      update.video_mode = req.body.videoMode === 'direct' ? 'direct' : 'embed';
    }
    const { data, error } = await supabase.from('episodes').update(update).eq('id', req.params.id).select().maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Episode not found.' });
    res.json(await presentEpisode(data));
  } catch (e) { next(e); }
});
app.delete('/api/admin/episodes/:id', adminOnly, async (req, res, next) => {
  try {
    const { data: item, error: findError } = await supabase.from('episodes').select('video_url').eq('id', req.params.id).maybeSingle();
    if (findError) throw findError;
    if (!item) return res.status(404).json({ error: 'Episode not found.' });
    if (item.video_url?.startsWith('storage://')) {
      const { error: storageError } = await supabase.storage.from(BUCKET).remove([item.video_url.slice('storage://'.length)]);
      if (storageError) console.error('Storage cleanup failed:', storageError.message);
    }
    const { error } = await supabase.from('episodes').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});



const aiGuideRequests = new Map();
app.post('/api/ai-guide', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const recent = (aiGuideRequests.get(ip) || []).filter(t => now - t < 60_000);
    if (recent.length >= 20) return res.status(429).json({ error: 'একটু অপেক্ষা করে আবার চেষ্টা করো।' });
    recent.push(now);
    aiGuideRequests.set(ip, recent);

    const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-8) : [];
    const last = [...rawMessages].reverse().find(m => m && m.role === 'user' && typeof m.content === 'string');
    const question = String(last?.content || '').trim().slice(0, 800);
    if (!question) return res.status(400).json({ error: 'আগে একটি প্রশ্ন লেখো।' });

    const [animeResult, episodeResult] = await Promise.all([
      supabase.from('anime_series').select('id,title,genre,year,overview,studio').order('created_at', { ascending: false }).limit(100),
      supabase.from('episodes').select('title,series_id').eq('published', true).limit(500)
    ]);
    if (animeResult.error) throw animeResult.error;
    const animeRows = animeResult.data || [];
    const episodeRows = episodeResult.error ? [] : (episodeResult.data || []);
    const q = question.toLowerCase();
    const bangla = /[\\u0980-\\u09FF]/.test(question) || /ki |kivabe|kothay|dao|bolo|ache|ase|khuj|dekhbo|parbo/i.test(question);
    const counts = new Map();
    for (const ep of episodeRows) if (ep.series_id) counts.set(ep.series_id, (counts.get(ep.series_id) || 0) + 1);
    const terms = q.split(/[^a-z0-9\\u0980-\\u09ff]+/i).filter(t => t.length > 2);
    const matches = animeRows.map(a => { const hay = [a.title,a.genre,a.overview,a.studio].join(' ').toLowerCase(); const score = hay.includes(q) ? 100 : terms.reduce((n,t) => n + (hay.includes(t) ? 1 : 0), 0); return { a, score }; }).filter(x => x.score > 0).sort((a,b) => b.score-a.score).slice(0,6).map(x => x.a);
    const showList = rows => rows.map(a => '• ' + a.title + (a.genre ? ' — ' + a.genre : '') + ' (' + (counts.get(a.id) || 0) + ' published episode)').join('\\n');

    let reply = '';
    if (/hello|hi\\b|hey|assalamu|salam|হ্যালো|আসসালামু|সালাম/.test(q)) {
      reply = bangla ? 'হ্যালো! আমি Animexd Guide 😊 Anime খোঁজা, episode দেখা, gallery ব্যবহার বা website-এর সমস্যা নিয়ে জিজ্ঞেস করতে পারো।' : 'Hello! I’m Animexd Guide. Ask me to find anime in the catalogue, explain episodes, or help you use the website.';
    } else if (/anime|অ্যানিমে|নাম|title|khuj|search|খুঁজ/.test(q) && matches.length) {
      reply = (bangla ? 'তোমার প্রশ্নের সঙ্গে মিলে এমন Anime পেয়েছি:\\n' : 'Here are catalogue matches:\\n') + showList(matches);
    } else if (/recommend|suggest|ki dekh|কী দেখ|দেখার|ভালো anime|valo anime/.test(q)) {
      const recs = animeRows.slice(0,5);
      reply = recs.length ? (bangla ? 'Animexd catalogue থেকে কয়েকটি Anime দেখতে পারো:\\n' : 'A few titles from the Animexd catalogue:\\n') + showList(recs) : (bangla ? 'এখনো catalogue-এ Anime যোগ হয়নি। পরে আবার দেখো।' : 'The catalogue is empty right now. Check back after titles are added.');
    } else if (/episode|পর্ব|ep\b|gallery|গ্যালারি/.test(q)) {
      reply = bangla ? 'কোনো Anime-এর episode দেখতে: Home page থেকে Anime poster-এ চাপ দাও, তার detail/gallery page খুলবে। সেখানে প্রকাশিত episode থাকলে Watch চাপ দাও।' : 'To watch an episode, tap an anime poster on the home page. Its detail/gallery page shows published episodes; tap Watch to play one.';
      if (matches.length) reply += '\\n\\n' + (bangla ? 'মিলে যাওয়া title:\\n' : 'Matching title:\\n') + showList(matches);
    } else if (/upload|আপলোড|admin|এডমিন/.test(q)) {
      reply = bangla ? 'Anime বা episode upload শুধু site admin করতে পারবে। Private admin page-এ login করে আগে Anime তৈরি করো, তারপর সেই Anime-এর gallery/series নির্বাচন করে episode যোগ করো। কেবল নিজের বা upload করার অনুমতি আছে এমন video ব্যবহার করবে। Password বা secret key chat-এ দিও না।' : 'Only the site admin can upload. Sign in to the private admin page, create the anime first, then select that series when adding episodes. Upload only videos you own or are authorized to distribute. Never share passwords or secret keys in chat.';
    } else if (/watch|play|দেখব|চালাব|ভিডিও|video/.test(q)) {
      reply = bangla ? 'Anime দেখতে Home page থেকে poster নির্বাচন করো, gallery page-এ episode বেছে Watch চাপ দাও। ভিডিও না চললে page refresh করো; তবুও সমস্যা হলে episode-এর নামসহ admin-কে জানাও।' : 'Choose an anime poster on the home page, open its gallery, select an episode, and tap Watch. If playback fails, refresh and report the episode title to the site admin.';
    } else if (/website|কিভাবে|কীভাবে|help|সাহায্য|guide|কোথায়/.test(q)) {
      reply = bangla ? 'আমি Animexd ব্যবহার শেখাতে পারি। Home page-এ search দিয়ে title খুঁজবে, poster চাপলে anime gallery খুলবে, আর episode card থেকে Watch করবে। কোন ধাপে আটকে গেছো বলো।' : 'Use the home-page search to find a title, tap its poster to open the anime gallery, then choose an episode and press Watch. Tell me which step is confusing.';
    } else if (matches.length) {
      reply = (bangla ? 'এই title-গুলো catalogue-এ মিলে গেছে:\\n' : 'These catalogue titles may match:\\n') + showList(matches);
    } else {
      reply = bangla ? 'আমি এখন ফ্রি Animexd Guide—সীমিত প্রশ্নের উত্তর দিতে পারি। Anime-এর নাম লিখে খুঁজতে বলো, অথবা website, gallery, episode বা upload নিয়ে প্রশ্ন করো। এই title catalogue-এ না থাকলে এখনো যোগ করা হয়নি।' : 'I’m the free Animexd Guide, so I can answer a limited set of anime and website questions. Ask me to search a title or help with the gallery, episodes, or uploads. If a title is not listed, it may not have been added yet.';
    }
    res.json({ reply, mode: 'free-guide' });
  } catch (error) {
    console.error('AI Guide error:', error.message || error);
    res.status(500).json({ error: 'এখন উত্তর দেওয়া যাচ্ছে না। একটু পরে চেষ্টা করো।' });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message || err);
  const status = err instanceof multer.MulterError ? 400 : 500;
  res.status(status).json({ error: err.message || 'Request failed.' });
});
app.listen(PORT, () => console.log('Animexd running on port ' + PORT));
