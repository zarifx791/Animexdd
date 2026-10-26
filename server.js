const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
// Render terminates HTTPS at its proxy; trust it so secure session cookies work.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
// Default credentials for first-time setup. Keep the GitHub repository PRIVATE.
// You can later override both values using Render Environment Variables.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AnimeXD@2026';
const SESSION_SECRET = process.env.SESSION_SECRET || 'Animexd-session-secret-change-this-2026-10';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, {recursive:true});
fs.mkdirSync(UPLOAD_DIR, {recursive:true});
const DB = path.join(DATA_DIR, 'episodes.json');
if (!fs.existsSync(DB)) fs.writeFileSync(DB, '[]');
const readEpisodes = () => { try { return JSON.parse(fs.readFileSync(DB,'utf8')); } catch { return []; } };
const writeEpisodes = items => fs.writeFileSync(DB, JSON.stringify(items,null,2));

app.use(express.json({limit:'2mb'}));
app.use(session({
  secret: SESSION_SECRET || 'change-this-before-deploying',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly:true, sameSite:'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8*60*60*1000 }
}));
app.use(express.static(path.join(__dirname,'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (_req,_file,cb) => cb(null, UPLOAD_DIR),
  filename: (_req,file,cb) => {
    const ext = path.extname(file.originalname).slice(0,12).replace(/[^a-zA-Z0-9.]/g,'');
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2,8) + ext);
  }
});
const upload = multer({
  storage,
  limits: {fileSize: 1024*1024*1024},
  fileFilter: (_req,file,cb) => {
    if (file.mimetype.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/i.test(file.originalname)) cb(null,true);
    else cb(new Error('Video file only (MP4, WEBM, MOV).'));
  }
});
const adminOnly = (req,res,next) => req.session && req.session.isAdmin ? next() : res.status(401).json({error:'Please log in as admin.'});


const SERIES_DB = path.join(DATA_DIR, 'series.json');
if (!fs.existsSync(SERIES_DB)) fs.writeFileSync(SERIES_DB, '[]');
const readSeries = () => { try { return JSON.parse(fs.readFileSync(SERIES_DB,'utf8')); } catch { return []; } };
const writeSeries = items => fs.writeFileSync(SERIES_DB, JSON.stringify(items,null,2));
app.get('/api/anime', (_req,res) => res.json(readSeries()));
app.get('/api/anime/:id', (req,res) => {
  const item = readSeries().find(x => x.id === req.params.id);
  if (!item) return res.status(404).json({error:'Anime not found.'});
  res.json({...item, episodes: readEpisodes().filter(e => e.seriesId === item.id && e.published)});
});
app.post('/api/admin/anime', adminOnly, (req,res) => {
  const title = String(req.body.title || '').trim();
  if (!title) return res.status(400).json({error:'Anime title is required.'});
  const all = readSeries();
  const item = {id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),title:title.slice(0,160),poster:String(req.body.poster||'').trim().slice(0,1000),overview:String(req.body.overview||'').trim().slice(0,3000),year:String(req.body.year||'').slice(0,10),studio:String(req.body.studio||'').trim().slice(0,160),writer:String(req.body.writer||'').trim().slice(0,160),genre:String(req.body.genre||'').trim().slice(0,300),language:String(req.body.language||'').trim().slice(0,100),screenshots:String(req.body.screenshots||'').split(/\n|,/).map(x=>x.trim()).filter(Boolean).slice(0,8),createdAt:new Date().toISOString()};
  all.unshift(item); writeSeries(all); res.json(item);
});
app.delete('/api/admin/anime/:id', adminOnly, (req,res) => {
  const all = readSeries();
  if (!all.some(x=>x.id===req.params.id)) return res.status(404).json({error:'Anime not found.'});
  writeSeries(all.filter(x=>x.id!==req.params.id));
  writeEpisodes(readEpisodes().map(e=>e.seriesId===req.params.id?{...e,seriesId:''}:e)); res.json({ok:true});
});

app.get('/api/episodes', (_req,res) => res.json(readEpisodes().filter(e=>e.published)));
app.post('/api/admin/login', (req,res) => {
  if (req.body && req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return req.session.save(err => {
      if (err) return res.status(500).json({error:'Could not save admin session. Please try again.'});
      res.json({ok:true});
    });
  }
  res.status(401).json({error:'Wrong password.'});
});
app.post('/api/admin/logout', adminOnly, (req,res) => req.session.destroy(()=>res.json({ok:true})));
app.get('/api/admin/episodes', adminOnly, (_req,res) => res.json(readEpisodes()));
app.post('/api/admin/episodes', adminOnly, upload.single('video'), (req,res) => {
  const title = String(req.body.title || '').trim();
  if (!title) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({error:'Episode title is required.'});
  }
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    title: title.slice(0,160),
    description: String(req.body.description || '').slice(0,2000),
    seriesId: String(req.body.seriesId || '').trim().slice(0,100),
    videoUrl: req.file ? '/uploads/' + req.file.filename : String(req.body.videoUrl || '').trim(),
    published: req.body.published !== 'false',
    createdAt: new Date().toISOString()
  };
  if (!item.videoUrl) return res.status(400).json({error:'Upload a video or provide a direct video URL.'});
  const all = readEpisodes(); all.unshift(item); writeEpisodes(all); res.json(item);
});
app.patch('/api/admin/episodes/:id', adminOnly, (req,res) => {
  const all = readEpisodes(); const item = all.find(e=>e.id===req.params.id);
  if (!item) return res.status(404).json({error:'Episode not found.'});
  if (typeof req.body.published === 'boolean') item.published = req.body.published;
  writeEpisodes(all); res.json(item);
});
app.delete('/api/admin/episodes/:id', adminOnly, (req,res) => {
  const all = readEpisodes(); const item = all.find(e=>e.id===req.params.id);
  if (!item) return res.status(404).json({error:'Episode not found.'});
  if (item.videoUrl && item.videoUrl.startsWith('/uploads/')) {
    const p = path.join(UPLOAD_DIR, path.basename(item.videoUrl));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  writeEpisodes(all.filter(e=>e.id!==req.params.id)); res.json({ok:true});
});
app.use((err,_req,res,_next) => {
  const status = err instanceof multer.MulterError ? 400 : 400;
  res.status(status).json({error:err.message || 'Request failed.'});
});
app.listen(PORT, () => console.log(`Animexd running on port ${PORT}`));
