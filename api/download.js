const express = require('express');
const axios = require('axios');
const app = express();

const DOMAINS = [
  'terabox.com','teraboxapp.com','1024tera.com','freeterabox.com',
  'terabox.fun','terabox.app','teraboxlink.com','terasharelink.com',
  'terafileshare.com','teraboxshare.com','4funbox.com','mirrobox.com',
  'nephobox.com','momerybox.com','tibibox.com'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function getSurl(url) {
  const m = url.match(/surl=([a-zA-Z0-9_-]+)/) || url.match(/\/s\/1([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

function isValidUrl(url) {
  return DOMAINS.some(d => url.includes(d));
}

// ========== METHOD 1: Public Share API ==========
async function method1_shareApi(surl) {
  const { data } = await axios.get('https://www.terabox.com/api/shorturlinfo', {
    params: { shorturl: `1${surl}`, root: 1 },
    headers: { 'User-Agent': UA, Referer: 'https://www.terabox.com/' },
    timeout: 15000
  });
  if (data.errno === 0 && data.list?.length) return data;
  throw new Error('Method 1 failed');
}

// ========== METHOD 2: Share List Endpoint ==========
async function method2_shareList(surl) {
  const { data } = await axios.get('https://www.terabox.com/share/list', {
    params: { app_id: '250528', shorturl: `1${surl}`, root: 1, page: 1, num: 1000 },
    headers: { 'User-Agent': UA, Referer: 'https://www.terabox.com/' },
    timeout: 15000
  });
  if (data.errno === 0 && data.list?.length) return data;
  throw new Error('Method 2 failed');
}

// ========== METHOD 3: HTML Scrape - Extract from page JS ==========
async function method3_scrape(url) {
  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml'
    },
    timeout: 20000,
    maxRedirects: 5
  });

  // Extract JSON data embedded in page
  const match = html.match(/window\.__InitialState\s*=\s*({.+?})\s*;?\s*<\/script>/s)
    || html.match(/"list"\s*:\s*(\[.+?\])/s)
    || html.match(/locals\.mbox\s*=\s*({.+?});/s);

  if (!match) throw new Error('Method 3: no data in HTML');

  let parsed;
  try { parsed = JSON.parse(match[1]); } catch { throw new Error('Method 3: parse fail'); }

  const list = parsed.list || parsed.file_list?.list || [parsed];
  if (!list.length) throw new Error('Method 3: empty list');

  return {
    list,
    shareid: parsed.shareid || parsed.share_id,
    uk: parsed.uk || parsed.user?.uk,
    sign: parsed.sign,
    timestamp: parsed.timestamp
  };
}

// ========== METHOD 4: Alternate domain rotation ==========
async function method4_domainRotate(surl) {
  const altDomains = [
    'https://www.1024tera.com',
    'https://www.4funbox.com',
    'https://www.freeterabox.com',
    'https://www.teraboxapp.com'
  ];

  for (const base of altDomains) {
    try {
      const { data } = await axios.get(`${base}/api/shorturlinfo`, {
        params: { shorturl: `1${surl}`, root: 1 },
        headers: { 'User-Agent': UA, Referer: `${base}/` },
        timeout: 12000
      });
      if (data.errno === 0 && data.list?.length) return data;
    } catch { continue; }
  }
  throw new Error('Method 4: all domains failed');
}

// ========== METHOD 5: DBox proxy API (public mirrors) ==========
async function method5_publicProxy(surl) {
  const proxies = [
    `https://terabox-dl.qtcloud.workers.dev/api/get-info?shorturl=1${surl}`,
    `https://teradl-api.vercel.app/api?shorturl=1${surl}`,
  ];

  for (const proxyUrl of proxies) {
    try {
      const { data } = await axios.get(proxyUrl, { timeout: 15000 });
      if (data.list?.length || data.files?.length) return data;
    } catch { continue; }
  }
  throw new Error('Method 5: proxies failed');
}

// ========== MASTER EXTRACTOR - tries all methods ==========
async function extractFileInfo(url, surl) {
  const methods = [
    () => method1_shareApi(surl),
    () => method2_shareList(surl),
    () => method3_scrape(url),
    () => method4_domainRotate(surl),
    () => method5_publicProxy(surl),
  ];

  const errors = [];

  for (let i = 0; i < methods.length; i++) {
    try {
      const result = await methods[i]();
      console.log(`✅ Method ${i + 1} succeeded`);
      return result;
    } catch (err) {
      errors.push(`Method ${i + 1}: ${err.message}`);
      console.log(`❌ Method ${i + 1} failed, trying next...`);
    }
  }

  throw new Error(`All methods failed:\n${errors.join('\n')}`);
}

// ========== DOWNLOAD LINK EXTRACTION ==========
async function getDirectLink(fs_id, shareid, uk, surl) {
  // Try multiple download endpoints
  const endpoints = [
    {
      url: 'https://www.terabox.com/share/download',
      params: { app_id: '250528', shareid, uk, fid_list: `[${fs_id}]`, shorturl: `1${surl}`, nozip: 0 }
    },
    {
      url: 'https://www.1024tera.com/share/download',
      params: { app_id: '250528', shareid, uk, fid_list: `[${fs_id}]`, shorturl: `1${surl}`, nozip: 0 }
    },
    {
      url: 'https://www.freeterabox.com/share/download',
      params: { app_id: '250528', shareid, uk, fid_list: `[${fs_id}]`, shorturl: `1${surl}`, nozip: 0 }
    }
  ];

  for (const ep of endpoints) {
    try {
      const { data } = await axios.get(ep.url, {
        params: ep.params,
        headers: { 'User-Agent': UA, Referer: 'https://www.terabox.com/' },
        timeout: 20000
      });
      if (data.dlink || data.list?.[0]?.dlink) {
        return data.dlink || data.list[0].dlink;
      }
    } catch { continue; }
  }

  throw new Error('Could not get download link from any endpoint');
}

// ========== ROUTES ==========

app.get('/api/info', async (req, res) => {
  try {
    const url = decodeURIComponent(req.query.url || '');
    if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'Invalid Terabox URL' });

    const surl = getSurl(url);
    if (!surl) return res.status(400).json({ error: 'Cannot extract surl' });

    const data = await extractFileInfo(url, surl);
    const list = data.list || data.files || [];

    const files = list.map(f => ({
      name: f.server_filename || f.name || 'unknown',
      fs_id: f.fs_id,
      size: f.size || 0,
      sizeMB: ((f.size || 0) / (1024 * 1024)).toFixed(2) + ' MB',
      isDir: f.isdir === 1,
      thumb: f.thumbs?.url3 || f.thumb || null,
      dlink: f.dlink || null
    }));

    res.json({
      success: true,
      shareid: data.shareid,
      uk: data.uk,
      sign: data.sign,
      timestamp: data.timestamp,
      surl,
      files
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const { fs_id, shareid, uk, surl, dlink } = req.query;

    let link = dlink;
    if (!link) {
      if (!fs_id || !shareid || !uk || !surl) {
        return res.status(400).json({ error: 'Need dlink OR (fs_id + shareid + uk + surl)' });
      }
      link = await getDirectLink(fs_id, shareid, uk, surl);
    }

    res.json({ success: true, downloadLink: link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', async (req, res) => {
  try {
    const dlUrl = decodeURIComponent(req.query.url || '');
    if (!dlUrl) return res.status(400).json({ error: 'url required' });

    const headers = { 'User-Agent': UA, Referer: 'https://www.terabox.com/' };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const response = await axios({
      method: 'GET',
      url: dlUrl,
      headers,
      responseType: 'stream',
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']
      .forEach(h => { if (response.headers[h]) res.setHeader(h, response.headers[h]); });

    res.status(response.status);
    response.data.pipe(res);
    response.data.on('error', () => res.end());
    req.on('close', () => response.data.destroy());
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: '🟢 alive',
    cookies: 'NOT NEEDED',
    methods: '5 fallback extraction methods',
    endpoints: {
      '/api/info?url=TERABOX_LINK': 'Get file info',
      '/api/download?fs_id=X&shareid=X&uk=X&surl=X': 'Get direct link',
      '/api/stream?url=ENCODED_DL_LINK': 'Stream/proxy download (large files)'
    },
    supported: DOMAINS
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Terabox API running on ${PORT} — 5 methods, 0 cookies`));
