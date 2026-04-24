const axios = require('axios');
const { URL } = require('url');

const TERABOX_DOMAINS = [
  'terabox.com', 'teraboxapp.com', '1024tera.com',
  'freeterabox.com', 'terabox.app', 'terabox.fun',
  'teraboxlink.com', 'terasharelink.com', '4funbox.com',
  'mirrobox.com', 'nephobox.com', '1024terabox.com',
  'terabox.club', 'terasharefile.com', 'tibibox.com', 'gibibox.com'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function extractSurl(url) {
  try {
    const parsed = new URL(url);
    const surl = parsed.searchParams.get('surl');
    if (surl) return surl;
    const pathMatch = parsed.pathname.match(/\/s\/1?([a-zA-Z0-9_-]+)/);
    if (pathMatch) return pathMatch[1];
    return null;
  } catch {
    return null;
  }
}

function isValidUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '');
    return TERABOX_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function formatSize(bytes) {
  if (!bytes) return 'Unknown';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, s = bytes;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(2)} ${u[i]}`;
}

async function getShortUrlInfo(surl) {
  const client = axios.create({
    timeout: 30000,
    maxRedirects: 10,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  });

  // Step 1: Hit the share page to get redirect & cookies
  const pageResp = await client.get(`https://www.terabox.com/wap/share/filelist?surl=${surl}`, {
    headers: { 'Referer': 'https://www.terabox.com/' }
  });

  const html = pageResp.data;
  const cookies = (pageResp.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

  // Extract data from window.__INITIAL_STATE__ or inline JSON
  let data = null;

  // Try INITIAL_STATE
  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.*?});?\s*<\/script>/s);
  if (stateMatch) {
    try { data = JSON.parse(stateMatch[1]); } catch {}
  }

  // Try locals pattern
  if (!data) {
    const localsMatch = html.match(/locals\.mset\(({.*?})\)/s);
    if (localsMatch) {
      try { data = JSON.parse(localsMatch[1]); } catch {}
    }
  }

  // Regex fallback for individual fields
  let shareid = '', uk = '', sign = '', timestamp = '', jsToken = '';

  if (data) {
    // Navigate nested structures
    const flat = JSON.stringify(data);
    shareid = (flat.match(/"shareid"\s*:\s*(\d+)/) || [])[1] || '';
    uk = (flat.match(/"uk"\s*:\s*(\d+)/) || [])[1] || '';
    sign = (flat.match(/"sign"\s*:\s*"([^"]+)"/) || [])[1] || '';
    timestamp = (flat.match(/"timestamp"\s*:\s*(\d+)/) || [])[1] || '';
    jsToken = (flat.match(/"jsToken"\s*:\s*"([^"]+)"/) || [])[1] || '';
  }

  if (!shareid) shareid = (html.match(/shareid['":\s]*(\d+)/i) || [])[1] || '';
  if (!uk) uk = (html.match(/"uk"\s*:\s*(\d+)/) || [])[1] || '';
  if (!sign) sign = (html.match(/"sign"\s*:\s*"([^"]+)"/) || [])[1] || '';
  if (!timestamp) timestamp = (html.match(/"timestamp"\s*:\s*(\d+)/) || [])[1] || '';
  if (!jsToken) {
    jsToken = (html.match(/fn%28%22(.*?)%22%29/) || [])[1] || '';
    if (!jsToken) jsToken = (html.match(/"jsToken"\s*:\s*"([^"]+)"/) || [])[1] || '';
    if (!jsToken) jsToken = (html.match(/locals\.token\s*=\s*['"]([^'"]+)/) || [])[1] || '';
  }

  // Try to extract file list directly from page data
  let fileList = [];
  const listMatch = html.match(/"list"\s*:\s*(\[.*?\])\s*[,}]/s);
  if (listMatch) {
    try { fileList = JSON.parse(listMatch[1]); } catch {}
  }

  return { shareid, uk, sign, timestamp, jsToken, surl, cookies, fileList };
}

async function fetchFileList(info) {
  // If we already got files from page, return them
  if (info.fileList && info.fileList.length > 0) return info.fileList;

  const params = {
    app_id: '250528',
    shorturl: info.surl,
    root: '1',
    page: '1',
    num: '100'
  };

  if (info.jsToken) params.jsToken = info.jsToken;
  if (info.shareid) params.shareid = info.shareid;
  if (info.uk) params.uk = info.uk;

  const resp = await axios.get('https://www.terabox.com/share/list', {
    params,
    headers: {
      'User-Agent': UA,
      'Referer': `https://www.terabox.com/wap/share/filelist?surl=${info.surl}`,
      'Cookie': info.cookies || ''
    },
    timeout: 20000
  });

  if (resp.data && resp.data.list) return resp.data.list;
  return [];
}

async function resolveDownloadLink(file, info) {
  // dlink from file list
  if (file.dlink) {
    try {
      const resp = await axios.get(file.dlink, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://www.terabox.com/',
          'Cookie': info.cookies || ''
        },
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        timeout: 15000
      });
      return resp.headers.location || file.dlink;
    } catch (e) {
      if (e.response && e.response.headers.location) {
        return e.response.headers.location;
      }
      return file.dlink;
    }
  }

  // Fallback: hit download endpoint
  try {
    const params = {
      app_id: '250528',
      shareid: info.shareid,
      uk: info.uk,
      fid_list: `[${file.fs_id}]`,
      sign: info.sign,
      timestamp: info.timestamp,
      product: 'share',
      nozip: '0'
    };

    if (info.jsToken) params.jsToken = info.jsToken;

    const resp = await axios.get('https://www.terabox.com/share/download', {
      params,
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.terabox.com/',
        'Cookie': info.cookies || ''
      },
      timeout: 20000
    });

    const dlink = resp.data?.dlink || resp.data?.list?.[0]?.dlink || '';
    return dlink;
  } catch {
    return '';
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing url parameter. Usage: /download?url=TERABOX_LINK'
    });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid Terabox URL',
      supported_domains: TERABOX_DOMAINS
    });
  }

  const surl = extractSurl(url);
  if (!surl) {
    return res.status(400).json({
      status: 'error',
      message: 'Could not extract share ID from URL'
    });
  }

  try {
    const info = await getShortUrlInfo(surl);
    const files = await fetchFileList(info);

    if (!files || files.length === 0) {
      return res.status(404).json({
        status: 'error',
        message: 'No files found. Link may be expired or private.'
      });
    }

    const results = [];

    for (const file of files) {
      const downloadUrl = await resolveDownloadLink(file, info);

      results.push({
        filename: file.server_filename || file.filename || 'unknown',
        size: formatSize(file.size),
        size_bytes: file.size || 0,
        fs_id: file.fs_id,
        download_url: downloadUrl,
        is_dir: file.isdir === 1,
        md5: file.md5 || '',
        category: file.category || 0,
        thumbs: file.thumbs || {}
      });
    }

    return res.status(200).json({
      status: 'success',
      total_files: results.length,
      source_url: url,
      files: results
    });

  } catch (err) {
    return res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to process Terabox link',
      hint: 'Link may be expired, region-locked, or require login'
    });
  }
};
