const express = require('express');
const axios = require('axios');
const app = express();

const TERABOX_DOMAINS = [
  'terabox.com',
  'teraboxapp.com',
  '1024tera.com',
  'freeterabox.com',
  'terabox.fun',
  'terabox.app',
  'teraboxlink.com',
  'terasharelink.com',
  'terafileshare.com',
  'teraboxshare.com'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.terabox.com/',
  'Origin': 'https://www.terabox.com'
};

function extractShortUrl(url) {
  for (const domain of TERABOX_DOMAINS) {
    if (url.includes(domain)) return url;
  }
  return null;
}

function extractSurl(url) {
  const match = url.match(/surl=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  const pathMatch = url.match(/\/s\/1([a-zA-Z0-9_-]+)/);
  if (pathMatch) return pathMatch[1];
  return null;
}

async function getFileInfo(shareUrl) {
  const surl = extractSurl(shareUrl);
  if (!surl) throw new Error('Invalid Terabox URL');

  const infoUrl = `https://www.terabox.com/api/shorturlinfo?shorturl=1${surl}&root=1`;

  const res = await axios.get(infoUrl, {
    headers: HEADERS,
    timeout: 30000
  });

  if (res.data.errno !== 0) throw new Error(`Terabox API error: ${res.data.errno}`);

  const fileList = res.data.list || [];
  const title = res.data.title || 'Unknown';
  const uk = res.data.uk;
  const shareid = res.data.shareid;

  return { fileList, title, uk, shareid, surl };
}

async function getDownloadLink(fs_id, uk, shareid, surl) {
  const dlUrl = `https://www.terabox.com/api/download?shareid=${shareid}&uk=${uk}&fid_list=[${fs_id}]&shorturl=1${surl}`;

  const res = await axios.head(dlUrl, {
    headers: HEADERS,
    maxRedirects: 0,
    validateStatus: (s) => s >= 200 && s < 400,
    timeout: 30000
  }).catch(err => {
    if (err.response && err.response.headers.location) {
      return { redirectUrl: err.response.headers.location };
    }
    throw err;
  });

  return res.redirectUrl || res.headers?.location || dlUrl;
}

// === ROUTES ===

app.get('/api/info', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url parameter required' });

    const valid = extractShortUrl(decodeURIComponent(url));
    if (!valid) return res.status(400).json({ error: 'Not a valid Terabox URL' });

    const { fileList, title, uk, shareid, surl } = await getFileInfo(valid);

    const files = fileList.map(f => ({
      name: f.server_filename,
      fs_id: f.fs_id,
      size: f.size,
      sizeMB: (f.size / (1024 * 1024)).toFixed(2) + ' MB',
      isDir: f.isdir === 1,
      thumb: f.thumbs?.url3 || null,
      path: f.path
    }));

    res.json({ success: true, title, uk, shareid, surl, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/download', async (req, res) => {
  try {
    const { fs_id, uk, shareid, surl } = req.query;
    if (!fs_id || !uk || !shareid || !surl) {
      return res.status(400).json({ error: 'fs_id, uk, shareid, surl required' });
    }

    const link = await getDownloadLink(fs_id, uk, shareid, surl);
    res.json({ success: true, downloadLink: link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream', async (req, res) => {
  try {
    const { url: dlUrl } = req.query;
    if (!dlUrl) return res.status(400).json({ error: 'url param required' });

    const range = req.headers.range || undefined;
    const headersToSend = { ...HEADERS };
    if (range) headersToSend['Range'] = range;

    const response = await axios({
      method: 'GET',
      url: decodeURIComponent(dlUrl),
      headers: headersToSend,
      responseType: 'stream',
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    const fwd = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    fwd.forEach(h => {
      if (response.headers[h]) res.setHeader(h, response.headers[h]);
    });

    const cd = response.headers['content-disposition'];
    if (cd) res.setHeader('Content-Disposition', cd);

    res.status(response.status);
    response.data.pipe(res);

    response.data.on('error', () => res.end());
    req.on('close', () => response.data.destroy());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    endpoints: {
      info: '/api/info?url=TERABOX_LINK',
      download: '/api/download?fs_id=X&uk=X&shareid=X&surl=X',
      stream: '/api/stream?url=ENCODED_DL_URL'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Terabox API live on ${PORT}`));
