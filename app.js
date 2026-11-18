/* PDF Convert Free – browser-only Image / PDF / Word converter. Made by Dr. Kaushik. */
'use strict';

/* ---------- Language ---------- */
let LANG = 'en';
try { LANG = localStorage.getItem('pdfc-lang') || 'en'; } catch (e) {}
if (LANG !== 'en' && !(window.I18N && I18N[LANG])) LANG = 'en';
const T = s => (LANG !== 'en' && window.I18N && I18N[LANG] && I18N[LANG][s]) || s;

/* ---------- Libraries (loaded only when a tool needs them) ---------- */
const LIBS = {
  pdflib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  h2c: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js',
  heic: 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
  tess: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'
};
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const loaded = {};
function load(k) {
  if (!loaded[k]) {
    loaded[k] = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = LIBS[k];
      s.onload = () => { if (k === 'pdfjs') pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; res(); };
      s.onerror = () => { delete loaded[k]; s.remove(); rej(new Error('Could not load a required library. Check your internet connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  return loaded[k];
}

/* ---------- Saving files (works inside Claude and on any normal website) ---------- */
let dlNS = null;
const inClaude = !!(window.claude && typeof window.claude.use === 'function');
const dlReady = (async () => { try { if (inClaude) dlNS = await window.claude.use('downloads'); } catch (e) { dlNS = null; } })();
async function saveBlob(name, blob) {
  await dlReady;
  if (dlNS) {
    try { await dlNS.save({ filename: name, data: blob }); toast(T('Saved') + ': ' + name); }
    catch (e) { if (e && e.code === 'declined') return; toast('Could not save: ' + ((e && e.message) || 'unavailable')); }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base = n => n.replace(/\.[^.]+$/, '') || 'file';
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2800); }
const tick = () => new Promise(r => setTimeout(r, 0));
const A4 = [595.28, 841.89];

/* Device memory profile: decides safe image sizes and when to warn about big files */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobi/i.test(navigator.userAgent);
const MEM_GB = navigator.deviceMemory || (IS_IOS ? 3 : IS_MOBILE ? 4 : 8);
const TIER = !IS_MOBILE && MEM_GB >= 8 ? 'high' : (IS_IOS || MEM_GB <= 3) ? 'low' : 'mid';
const LIMITS = {
  high: { warnMB: 400, maxSide: 12000, docSide: 5000, maxPixels: 64e6 },
  mid: { warnMB: 120, maxSide: 8000, docSide: 4000, maxPixels: 32e6 },
  low: { warnMB: 60, maxSide: 6000, docSide: 3000, maxPixels: 16e6 }
}[TIER];
const capSide = n => Math.min(n, LIMITS.docSide);

function canvasToBlob(c, mime, q) {
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Image is too large for this device.')), mime, q));
}
function isHeic(f) { return /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type); }
function isPdf(f) { return /\.pdf$/i.test(f.name) || f.type === 'application/pdf'; }
function newCanvas(w, h, bg) {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d'); if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  return c;
}

async function fileToImage(file) {
  let blob = file;
  if (isHeic(file)) {
    await load('heic');
    const r = await heic2any({ blob: file, toType: 'image/png' });
    blob = Array.isArray(r) ? r[0] : r;
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw new Error('Could not read image "' + file.name + '". The format may not be supported by this browser.'); }
  img._url = url;
  return img;
}
async function fileToCanvas(file, scale = 1, bg = null, maxSide = LIMITS.maxSide) {
  const img = await fileToImage(file);
  try {
    let w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    const k = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(LIMITS.maxPixels / (w * h))); w *= k; h *= k;
    const c = newCanvas(w, h, bg);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(img._url); }
}

function parsePages(spec, n) {
  spec = (spec || '').trim();
  if (!spec || spec.toLowerCase() === 'all') return [...Array(n).keys()];
  const s = new Set();
  for (const part of spec.split(',')) {
    if (!part.trim()) continue;
    const m = part.trim().match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new Error('Invalid page range: "' + part.trim() + '". Use a format like 1-3, 5');
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i++) {
      if (i < 1 || i > n) throw new Error('Page ' + i + ' does not exist (this PDF has ' + n + ' pages).');
      s.add(i - 1);
    }
  }
  return [...s].sort((x, y) => x - y);
}
const rangeGroups = (spec, n) => spec.split(',').filter(p => p.trim()).map(p => ({ label: p.trim().replace(/\s+/g, ''), idx: parsePages(p, n) }));

async function openPdfLib(file) {
  await load('pdflib');
  try { return await PDFLib.PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true }); }
  catch (e) { throw new Error('Could not open "' + file.name + '". It may be damaged or password-protected.'); }
}
async function openPdfJs(file) {
  await load('pdfjs');
  try { return await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise; }
  catch (e) { throw new Error('Could not open "' + file.name + '". It may be damaged or password-protected.'); }
}
async function renderPdfPage(doc, i, scale) {
  const page = await doc.getPage(i);
  const v1 = page.getViewport({ scale: 1 });
  scale = Math.min(scale, Math.sqrt(LIMITS.maxPixels / (v1.width * v1.height)));
  const vp = page.getViewport({ scale });
  const c = newCanvas(vp.width, vp.height, '#ffffff');
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  c._pt = [v1.width, v1.height];
  page.cleanup();
  return c;
}
const closePdf = d => { try { if (d.destroy) d.destroy(); else if (d.loadingTask) d.loadingTask.destroy(); } catch (e) {} };
const pdfBlob = bytes => new Blob([bytes], { type: 'application/pdf' });
const jpegBytes = async (c, q) => new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', q)).arrayBuffer());

/* ---------- Minimal .docx writer ---------- */
function xmlEsc(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
async function buildDocx(blocks) {
  await load('jszip');
  const zip = new JSZip();
  let body = '', rels = '', n = 0;
  const MAXW = 6645000, MAXH = 9400000; // A4 with 0.5" margins, in EMU
  for (const b of blocks) {
    const ppr = '<w:pPr>' + (b.pageBreak ? '<w:pageBreakBefore/>' : '') + (b.type === 'p' ? '<w:spacing w:after="' + (b.after != null ? b.after : 120) + '"/>' : '') + '</w:pPr>';
    if (b.type === 'p') {
      const rpr = (b.bold || b.size) ? '<w:rPr>' + (b.bold ? '<w:b/>' : '') + (b.size ? '<w:sz w:val="' + Math.round(b.size * 2) + '"/>' : '') + '</w:rPr>' : '';
      body += '<w:p>' + ppr + '<w:r>' + rpr + '<w:t xml:space="preserve">' + xmlEsc(b.text) + '</w:t></w:r></w:p>';
    } else if (b.type === 'img') {
      n++;
      const fn = 'image' + n + '.' + b.ext;
      zip.file('word/media/' + fn, b.bytes);
      rels += '<Relationship Id="rIdImg' + n + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + fn + '"/>';
      let cx = b.w * 9525, cy = b.h * 9525;
      const k = Math.min(1, MAXW / cx, MAXH / cy);
      cx = Math.round(cx * k); cy = Math.round(cy * k);
      body += '<w:p>' + ppr + '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + n + '" name="Picture ' + n + '"/>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="' + n + '" name="' + fn + '"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="rIdImg' + n + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
    }
  }
  if (!body) body = '<w:p/>';
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>');
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}
/* OCR text → Word paragraphs: blank line = new paragraph, single line breaks are joined */
function ocrTextToBlocks(pagesText) {
  const blocks = [];
  pagesText.forEach((txt, i) => {
    const paras = txt.replace(/\r/g, '').split(/\n\s*\n/).map(p => joinLines(p.split('\n'))).filter(p => p.trim());
    if (!paras.length) paras.push('');
    paras.forEach((t, j) => blocks.push({ type: 'p', text: t, pageBreak: i > 0 && j === 0 }));
  });
  return blocks;
}
function joinLines(lines) {
  let out = '';
  for (let l of lines) {
    l = l.trim(); if (!l) continue;
    if (!out) out = l;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(l)) out = out.slice(0, -1) + l;
    else out += ' ' + l;
  }
  return out;
}
/* PDF page → paragraphs with headings, using text positions */
async function pdfPageBlocks(page) {
  const tc = await page.getTextContent();
  const items = tc.items.filter(it => 'str' in it && it.str.trim() !== '' || (it.str === ' ')).map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.height) || Math.hypot(it.transform[2], it.transform[3]) || 10 }));
  if (!items.length) return [];
  items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const it of items) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.y - it.y) < Math.max(L.h, it.h) * 0.5) {
      const gap = it.x - L.end;
      if (gap > it.h * 0.15 && !/\s$/.test(L.text) && !/^\s/.test(it.s)) L.text += ' ';
      L.text += it.s; L.end = Math.max(L.end, it.x + it.w); L.h = Math.max(L.h, it.h); L.x = Math.min(L.x, it.x);
    } else lines.push({ text: it.s, x: it.x, y: it.y, end: it.x + it.w, h: it.h });
  }
  lines.forEach(l => l.text = l.text.replace(/[\uf0a7\uf0b7\uf076\uf0d8\uf0fc]/g, '•').replace(/\s+/g, ' ').trim());
  const real = lines.filter(l => l.text);
  if (!real.length) return [];
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const hMed = med(real.map(l => l.h));
  const gaps = []; for (let i = 1; i < real.length; i++) { const g = real[i - 1].y - real[i].y; if (g > 0) gaps.push(g); }
  const gMed = gaps.length ? med(gaps) : hMed * 1.2;
  const right = Math.max(...real.map(l => l.end)), left = Math.min(...real.map(l => l.x));
  const bullet = /^([•●▪◦\-–*]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s/;
  const paras = []; let cur = null;
  for (let i = 0; i < real.length; i++) {
    const l = real[i], prev = real[i - 1];
    const big = l.h > hMed * 1.25;
    let brk = !cur;
    if (prev && cur) {
      const g = prev.y - l.y;
      if (g > gMed * 1.45 || g < 0) brk = true;
      else if (big !== cur.big || Math.abs(l.h - prev.h) > hMed * 0.25) brk = true;
      else if (bullet.test(l.text)) brk = true;
      else if (prev.end < left + (right - left) * 0.7 && /[.:;!?]$/.test(prev.text)) brk = true;
    }
    if (brk) { cur = { lines: [], big, h: l.h }; paras.push(cur); }
    cur.lines.push(l.text); cur.h = Math.max(cur.h, l.h);
  }
  return paras.map(p => {
    const text = joinLines(p.lines);
    return p.big ? { type: 'p', text, bold: true, size: Math.min(20, Math.max(13, Math.round(p.h * 0.95))) } : { type: 'p', text };
  });
}
const textToBlocks = pagesText => {
  const blocks = [];
  pagesText.forEach((txt, i) => {
    const lines = txt.split('\n').map(l => l.replace(/\s+$/, ''));
    const clean = []; for (const l of lines) if (l || (clean.length && clean[clean.length - 1] !== '')) clean.push(l);
    if (!clean.length) clean.push('');
    clean.forEach((t, j) => blocks.push({ type: 'p', text: t, pageBreak: i > 0 && j === 0 }));
  });
  return blocks;
};

/* ---------- Word (.docx) → pages (image + word positions for a hidden text layer) ---------- */
function waitImages(el) {
  return Promise.all([...el.querySelectorAll('img')].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
}
function collectWords(pg, clipTop, clipBottom) {
  const b = pg.getBoundingClientRect(), out = [], range = document.createRange();
  const walker = document.createTreeWalker(pg, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const re = /\S+/g; let m;
    while ((m = re.exec(node.nodeValue))) {
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
      const r = range.getClientRects()[0];
      if (!r || r.width <= 0) continue;
      const top = r.top - b.top, bottom = r.bottom - b.top;
      if (bottom <= clipTop + 1 || top >= clipBottom - 1) continue;
      out.push({ t: m[0], x: r.left - b.left, y: top, w: r.width, h: r.height });
    }
  }
  return out;
}
async function docxToPages(file, st) {
  if (!/\.docx$/i.test(file.name)) throw new Error('"' + file.name + '" is not a .docx file. Old .doc files are not supported – save it as .docx first.');
  await Promise.all([load('mammoth'), load('h2c')]);
  st(T('Reading Word file…'), 0.02);
  let html;
  try { html = (await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value; }
  catch (e) { throw new Error('Could not read "' + file.name + '". The file may be damaged.'); }
  if (!html.trim()) html = '<p>&nbsp;</p>';
  const host = document.createElement('div'); host.className = 'render-host'; document.body.appendChild(host);
  try {
    const measure = document.createElement('div'); measure.className = 'doccontent'; measure.style.position = 'relative';
    measure.innerHTML = html; host.appendChild(measure);
    await waitImages(measure);
    const H = 979, total = measure.scrollHeight, pages = [];
    let start = 0;
    for (const el of measure.children) {
      const top = el.offsetTop, bot = top + el.offsetHeight;
      if (bot - start > H) {
        if (top > start) { pages.push([start, top]); start = top; }
        while (bot - start > H) { pages.push([start, start + H]); start += H; }
      }
    }
    if (total > start || !pages.length) pages.push([start, Math.max(total, start + 1)]);
    measure.remove();
    const out = [];
    for (let i = 0; i < pages.length; i++) {
      st(T('Rendering page') + ' ' + (i + 1) + ' / ' + pages.length + '…', (i + 0.5) / pages.length);
      const [s, e] = pages[i];
      const pg = document.createElement('div'); pg.className = 'docpage';
      pg.innerHTML = '<div class="clip" style="height:' + (e - s) + 'px"><div class="doccontent" style="position:absolute;left:0;top:' + (-s) + 'px">' + html + '</div></div>';
      host.appendChild(pg);
      await waitImages(pg);
      const words = collectWords(pg, 72, 72 + (e - s));
      const canvas = await html2canvas(pg, { scale: 2, backgroundColor: '#ffffff', logging: false });
      pg.remove();
      out.push({ canvas, words });
    }
    return out;
  } finally { host.remove(); }
}

/* ---------- OCR (Tesseract.js) ---------- */
let ocrWorker = null, ocrLang = null;
async function getOcr(lang, st) {
  await load('tess');
  if (ocrWorker && ocrLang === lang) return ocrWorker;
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch (e) {} ocrWorker = null; }
  st('Loading OCR engine and language data (first time can take a minute)…');
  try { ocrWorker = await Tesseract.createWorker(lang.split('+'), 1); }
  catch (e) {
    throw new Error('Could not load the OCR engine or its language data. Check your internet connection.' + (inClaude ? ' (Inside the Claude preview, OCR downloads may be blocked – it works once the site is on GitHub Pages.)' : ''));
  }
  ocrLang = lang;
  return ocrWorker;
}
async function* ocrSources(files, st, fr) {
  for (const f of files) {
    if (isPdf(f)) {
      const doc = await openPdfJs(f);
      for (let i = 1; i <= doc.numPages; i++) { st(f.name + ': ' + T('reading page') + ' ' + i + ' / ' + doc.numPages + '…', fr ? fr() : null); yield { canvas: await renderPdfPage(doc, i, 2.5), file: f }; }
      closePdf(doc);
    } else {
      st(T('Reading') + ' ' + f.name + '…', fr ? fr() : null);
      yield { canvas: await fileToCanvas(f, 1, '#ffffff', capSide(3500)), file: f };
    }
  }
}
/* ---------- Scan helpers (auto-crop + document filters) ---------- */
function otsu(gray) {
  const hist = new Array(256).fill(0); for (const g of gray) hist[g]++;
  const total = gray.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF; const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}
function autoCrop(c) {
  const s = Math.min(1, 400 / Math.max(c.width, c.height));
  const w = Math.max(1, Math.round(c.width * s)), h = Math.max(1, Math.round(c.height * s));
  const sm = newCanvas(w, h); const sx = sm.getContext('2d'); sx.drawImage(c, 0, 0, w, h);
  const d = sx.getImageData(0, 0, w, h).data; const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
  const thr = otsu(gray);
  const rowF = new Float32Array(h), colF = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (gray[y * w + x] > thr) { rowF[y]++; colF[x]++; }
  const pick = (arr, len, n) => { let a = 0, b = len - 1; while (a < len && arr[a] / n < 0.4) a++; while (b > a && arr[b] / n < 0.4) b--; return [a, b]; };
  const [top, bottom] = pick(rowF, h, w), [left, right] = pick(colF, w, h);
  const bw = right - left + 1, bh = bottom - top + 1;
  if (bw < w * 0.3 || bh < h * 0.3 || (bw > w * 0.97 && bh > h * 0.97)) return c;
  const ins = 0.01;
  const X = (left / s) + c.width * ins, Y = (top / s) + c.height * ins, W = bw / s - 2 * c.width * ins, Hh = bh / s - 2 * c.height * ins;
  const out = newCanvas(W, Hh); out.getContext('2d').drawImage(c, X, Y, W, Hh, 0, 0, out.width, out.height);
  return out;
}
function localMean(gray, w, h, r) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) { let row = 0; for (let x = 1; x <= w; x++) { row += gray[(y - 1) * w + x - 1]; I[y * (w + 1) + x] = I[(y - 1) * (w + 1) + x] + row; } }
  const m = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      m[y * w + x] = (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return m;
}
function docFilter(c, mode) {
  if (mode === 'original') return c;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  const id = ctx.getImageData(0, 0, w, h), d = id.data, n = w * h;
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
  if (mode === 'gray') { for (let i = 0; i < n; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = gray[i]; }
  else {
    const mean = localMean(gray, w, h, Math.max(8, Math.round(Math.max(w, h) / 30)));
    for (let i = 0; i < n; i++) {
      if (mode === 'bw') { const v = gray[i] < mean[i] * 0.86 ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
      else { const k = 245 / Math.max(mean[i], 40); for (let ch = 0; ch < 3; ch++) d[i * 4 + ch] = Math.min(255, d[i * 4 + ch] * k); }
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/* Find the paper in a photo: largest bright region → its 4 corners (normalised 0..1) */
function detectQuad(c) {
  const s = Math.min(1, 360 / Math.max(c.width, c.height));
  const w = Math.max(1, Math.round(c.width * s)), h = Math.max(1, Math.round(c.height * s));
  const sm = newCanvas(w, h); const sx = sm.getContext('2d'); sx.drawImage(c, 0, 0, w, h);
  const d = sx.getImageData(0, 0, w, h).data; const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
  const thr = otsu(gray);
  const lab = new Int32Array(w * h).fill(-1); let best = -1, bestN = 0; const stack = [];
  for (let p = 0; p < w * h; p++) {
    if (gray[p] <= thr || lab[p] !== -1) continue;
    let n = 0; stack.push(p); lab[p] = p;
    while (stack.length) {
      const q = stack.pop(); n++; const x = q % w, y = (q / w) | 0;
      if (x > 0 && lab[q - 1] === -1 && gray[q - 1] > thr) { lab[q - 1] = p; stack.push(q - 1); }
      if (x < w - 1 && lab[q + 1] === -1 && gray[q + 1] > thr) { lab[q + 1] = p; stack.push(q + 1); }
      if (y > 0 && lab[q - w] === -1 && gray[q - w] > thr) { lab[q - w] = p; stack.push(q - w); }
      if (y < h - 1 && lab[q + w] === -1 && gray[q + w] > thr) { lab[q + w] = p; stack.push(q + w); }
    }
    if (n > bestN) { bestN = n; best = p; }
  }
  if (best < 0 || bestN < w * h * 0.15 || bestN > w * h * 0.97) return null;
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (let p = 0; p < w * h; p++) {
    if (lab[p] !== best) continue;
    const x = p % w, y = (p / w) | 0;
    if (x + y < tl[2]) tl = [x, y, x + y];
    if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y];
    if (x - y < bl[2]) bl = [x, y, x - y];
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [x / (w - 1 || 1), y / (h - 1 || 1)]);
  const area = Math.abs(polyArea(q));
  if (area < 0.15 || area > 0.96) return null;
  return q;
}
function polyArea(q) { let a = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; a += x1 * y2 - x2 * y1; } return a / 2; }
/* Solve homography mapping (u,v) → (x,y) for 4 point pairs */
function homography(src, dst) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
  }
  for (let c = 0; c < 8; c++) { // Gaussian elimination with pivoting
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; B[r] -= f * B[c]; }
  }
  const hh = B.map((b, i) => b / A[i][i]);
  return [...hh, 1];
}
/* Straighten the 4-corner area of a photo into a flat rectangle */
function warpQuad(c, qn) {
  const q = qn.map(([x, y]) => [x * c.width, y * c.height]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, H = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const k = Math.min(1, LIMITS.docSide / Math.max(W, H)); W = Math.max(10, Math.round(W * k)); H = Math.max(10, Math.round(H * k));
  const Hm = homography([[0, 0], [W, 0], [W, H], [0, H]], q);
  const src = c.getContext('2d').getImageData(0, 0, c.width, c.height), sd = src.data, sw = c.width, sh = c.height;
  const out = newCanvas(W, H); const octx = out.getContext('2d'); const od = octx.createImageData(W, H); const dd = od.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const z = Hm[6] * x + Hm[7] * y + 1;
      let sx = (Hm[0] * x + Hm[1] * y + Hm[2]) / z, sy = (Hm[3] * x + Hm[4] * y + Hm[5]) / z;
      sx = Math.min(sw - 1.001, Math.max(0, sx)); sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, o = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++) dd[o + ch] = (sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx) * (1 - fy) + (sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx) * fy;
      dd[o + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}
/* Scan: per-photo corners (auto-detected, adjustable by dragging) */
const scanQuads = new WeakMap();   // File → {q, auto, thumb, w, h}
let scanToken = 0;
async function scanLoad(keep) {
  const box = $('#extra'); if (!box) return;
  const my = ++scanToken;
  for (const f of state.files) {
    if (scanQuads.has(f.file)) continue;
    try {
      const c = await fileToCanvas(f.file, 1, '#ffffff', 900);
      if (my !== scanToken) return;
      const q = detectQuad(c);
      scanQuads.set(f.file, { q: q || [[0, 0], [1, 0], [1, 1], [0, 1]], auto: !!q, thumb: c.toDataURL('image/jpeg', 0.75), w: c.width, h: c.height });
    } catch (e) { scanQuads.set(f.file, { q: [[0, 0], [1, 0], [1, 1], [0, 1]], auto: false, thumb: '', w: 1, h: 1, bad: true }); }
    renderScanGrid();
  }
  renderScanGrid();
}
function quadSvg(q) { return '<svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon points="' + q.map(p => p.join(',')).join(' ') + '" /></svg>'; }
function renderScanGrid() {
  const box = $('#extra'); if (!box) return;
  const items = state.files.map((f, i) => ({ f, i, s: scanQuads.get(f.file) }));
  if (!items.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<p class="hint2">' + esc(T('Check each page. Tap "Adjust corners" if the blue frame is not on the paper edges.')) + '</p><div class="sgrid">' + items.map(({ f, i, s }) => '<div class="scard">' +
    (s ? '<div class="sthumb"><span class="sbox"><img src="' + s.thumb + '" alt="">' + quadSvg(s.q) + '</span></div>' : '<div class="sthumb"><span class="spin"></span></div>') +
    '<div class="pnum">' + (i + 1) + ' · <small>' + esc(s ? (s.manual ? T('Adjusted') : s.auto ? T('Auto-detected') : T('Full photo')) : T('Checking…')) + '</small></div>' +
    (s && !s.bad ? '<button class="chip wide" data-adj="' + i + '">✥ ' + esc(T('Adjust corners')) + '</button>' : '') + '</div>').join('') + '</div>';
  box.querySelectorAll('[data-adj]').forEach(b => b.onclick = () => cornerEditor(state.files[+b.dataset.adj].file));
}
function cornerEditor(file) {
  const s = scanQuads.get(file); if (!s) return;
  let q = s.q.map(p => p.slice());
  openModal(T('Adjust corners'), '<div class="ced" id="ced"><img src="' + s.thumb + '" alt="" draggable="false"><svg viewBox="0 0 1 1" preserveAspectRatio="none" id="cedsvg"><polygon id="cedpoly"/></svg>' +
    [0, 1, 2, 3].map(i => '<div class="hnd" data-h="' + i + '" role="slider" aria-label="Corner ' + (i + 1) + '" tabindex="0"></div>').join('') + '</div><p class="mute center">' + esc(T('Drag the 4 circles onto the corners of the page.')) + '</p>',
    '<button class="chip" id="cfull">⬚ ' + esc(T('Whole photo')) + '</button><button class="chip" id="cauto">✨ ' + esc(T('Auto')) + '</button><button class="save" id="cdone">' + esc(T('Done')) + '</button>');
  const ed = $('#ced');
  const draw = () => {
    $('#cedpoly').setAttribute('points', q.map(p => p.join(',')).join(' '));
    ed.querySelectorAll('.hnd').forEach(h => { const p = q[+h.dataset.h]; h.style.left = p[0] * 100 + '%'; h.style.top = p[1] * 100 + '%'; });
  };
  ed.querySelectorAll('.hnd').forEach(h => {
    h.onpointerdown = e => {
      e.preventDefault(); h.setPointerCapture(e.pointerId);
      const move = ev => { const r = ed.getBoundingClientRect(); q[+h.dataset.h] = [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))]; draw(); };
      h.onpointermove = move; h.onpointerup = h.onpointercancel = () => { h.onpointermove = null; };
    };
    h.onkeydown = e => { const d = { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, -0.01], ArrowDown: [0, 0.01] }[e.key]; if (!d) return; e.preventDefault(); const p = q[+h.dataset.h]; p[0] = Math.min(1, Math.max(0, p[0] + d[0])); p[1] = Math.min(1, Math.max(0, p[1] + d[1])); draw(); };
  });
  $('#cfull').onclick = () => { q = [[0, 0], [1, 0], [1, 1], [0, 1]]; draw(); };
  $('#cauto').onclick = async () => { const c = await fileToCanvas(file, 1, '#ffffff', 900); const a = detectQuad(c); if (a) { q = a; draw(); } else toast(T('Could not find the page edges – drag the corners yourself.')); };
  $('#cdone').onclick = () => { s.q = q; s.manual = true; closeModal(); renderScanGrid(); };
  draw();
}
/* OCR clean-up: enlarge small images, even out lighting, straighten slight tilt */
function estimateSkew(c) {
  const s = Math.min(1, 700 / Math.max(c.width, c.height));
  const w = Math.max(1, Math.round(c.width * s)), h = Math.max(1, Math.round(c.height * s));
  const sm = newCanvas(w, h); const sx = sm.getContext('2d'); sx.drawImage(c, 0, 0, w, h);
  const d = sx.getImageData(0, 0, w, h).data; const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
  const thr = otsu(gray); const pts = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (gray[y * w + x] < thr) pts.push(x - w / 2, y - h / 2);
  if (pts.length < 200) return 0;
  const step = Math.max(1, Math.floor(pts.length / 2 / 40000)) * 2;
  const score = deg => {
    const a = deg * Math.PI / 180, sn = Math.sin(a), cs = Math.cos(a), bins = new Float32Array(h * 2 + 4);
    for (let i = 0; i < pts.length; i += step) { const yy = Math.round(-pts[i] * sn + pts[i + 1] * cs + h); if (yy >= 0 && yy < bins.length) bins[yy]++; }
    let s2 = 0; for (const b of bins) s2 += b * b; return s2;
  };
  let best = 0, bs = -1;
  for (let a = -6; a <= 6; a += 0.5) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  for (let a = best - 0.4; a <= best + 0.4; a += 0.1) { const v = score(a); if (v > bs) { bs = v; best = a; } }
  return Math.abs(best) < 0.15 ? 0 : best;
}
function rotateCanvas(c, deg) {
  const a = deg * Math.PI / 180, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
  const W = Math.round(c.width * cs + c.height * sn), H = Math.round(c.width * sn + c.height * cs);
  const out = newCanvas(W, H, '#ffffff'); const ctx = out.getContext('2d');
  ctx.translate(W / 2, H / 2); ctx.rotate(a); ctx.drawImage(c, -c.width / 2, -c.height / 2);
  return out;
}
function prepForOcr(c) {
  const long = Math.max(c.width, c.height);
  if (long < 1800) { const k = Math.min(2.5, 2200 / long); const u = newCanvas(c.width * k, c.height * k, '#ffffff'); const ux = u.getContext('2d'); ux.imageSmoothingQuality = 'high'; ux.drawImage(c, 0, 0, u.width, u.height); c = u; }
  const ang = estimateSkew(c);
  if (ang) c = rotateCanvas(c, -ang);
  return docFilter(c, 'enhance');
}

/* ---------- Tool runners: each returns [{name, blob, info?}] ---------- */
async function runImgConvert(files, o, st) {
  const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[o.fmt];
  const out = [];
  for (let i = 0; i < files.length; i++) {
    st(T('Converting') + ' ' + (i + 1) + ' / ' + files.length + '…', i / files.length); await tick();
    const c = await fileToCanvas(files[i], o.scale / 100, o.fmt === 'jpg' ? '#ffffff' : null);
    out.push({ name: base(files[i].name) + '.' + o.fmt, blob: await canvasToBlob(c, mime, o.q / 100), info: c.width + '×' + c.height + ' px' });
  }
  return out;
}

const RESIZE_PRESETS = {
  custom: null,
  passport: { w: 413, h: 531, fit: 'crop', max: '', min: '' },
  photo50: { w: 200, h: 230, fit: 'crop', max: '50', min: '10' },
  sign20: { w: 140, h: 60, fit: 'fit', max: '20', min: '' },
  kb100: { w: '', h: '', fit: 'fit', max: '100', min: '' },
  kb50: { w: '', h: '', fit: 'fit', max: '50', min: '' },
  kb20: { w: '', h: '', fit: 'fit', max: '20', min: '' }
};
function drawResized(img, W, H, fit, bg) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const c = newCanvas(W, H, bg); const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  if (fit === 'stretch') ctx.drawImage(img, 0, 0, c.width, c.height);
  else if (fit === 'crop') { const k = Math.max(c.width / iw, c.height / ih); const sw = c.width / k, sh = c.height / k; ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, c.width, c.height); }
  else { const k = Math.min(c.width / iw, c.height / ih); const dw = iw * k, dh = ih * k; ctx.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh); }
  return c;
}
async function runResize(files, o, st) {
  const out = [];
  const W0 = parseInt(o.w, 10) || 0, H0 = parseInt(o.h, 10) || 0;
  const maxKB = parseFloat(o.max) || 0, minKB = parseFloat(o.min) || 0;
  if (maxKB && minKB && minKB >= maxKB) throw new Error('Minimum size must be smaller than maximum size.');
  const fmt = (maxKB || minKB) ? 'jpg' : o.fmt;
  const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
  for (let i = 0; i < files.length; i++) {
    st(T('Resizing') + ' ' + (i + 1) + ' / ' + files.length + '…', i / files.length); await tick();
    const img = await fileToImage(files[i]);
    try {
      const iw = img.naturalWidth, ih = img.naturalHeight;
      let W = W0, H = H0;
      if (W && !H) H = Math.round(ih * W / iw); else if (H && !W) W = Math.round(iw * H / ih); else if (!W && !H) { W = iw; H = ih; }
      const fixed = !!(W0 || H0);
      let c = drawResized(img, W, H, (W0 && H0) ? o.fit : 'stretch', '#ffffff');
      let blob, warn = '';
      if (!maxKB && !minKB) blob = await canvasToBlob(c, mime, 0.92);
      else {
        const lim = maxKB ? maxKB * 1024 : Infinity;
        const best = async cv => { // highest quality that fits under the limit
          let lo = 0.05, hi = 0.95, good = null;
          const top = await canvasToBlob(cv, mime, hi); if (top.size <= lim) return top;
          for (let k = 0; k < 8; k++) { const q = (lo + hi) / 2; const b = await canvasToBlob(cv, mime, q); if (b.size <= lim) { good = b; lo = q; } else hi = q; }
          return good;
        };
        blob = await best(c);
        let tries = 0;
        while (!blob && !fixed && tries < 20) { tries++; c = drawResized(img, c.width * 0.85, c.height * 0.85, 'stretch', '#ffffff'); blob = await best(c); }
        if (!blob) { blob = await canvasToBlob(c, mime, 0.05); warn = ' · ⚠️ could not get under ' + maxKB + ' KB at this pixel size'; }
        if (minKB && blob.size < minKB * 1024) {
          const b1 = await canvasToBlob(c, mime, 1);
          if (b1.size <= lim) blob = b1;
          if (blob.size < minKB * 1024) warn += ' · ⚠️ smaller than ' + minKB + ' KB minimum – try a bigger pixel size';
        }
      }
      out.push({ name: base(files[i].name) + '-' + c.width + 'x' + c.height + '.' + fmt, blob, info: c.width + '×' + c.height + ' px' + warn });
    } finally { URL.revokeObjectURL(img._url); }
  }
  return out;
}

async function runScan(files, o, st) {
  await load('pdflib');
  const pdf = await PDFLib.PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    st(T('Processing page') + ' ' + (i + 1) + ' / ' + files.length + '…', i / files.length); await tick();
    let c = await fileToCanvas(files[i], 1, '#ffffff', capSide(3200));
    const s = scanQuads.get(files[i]);
    let q = s && (s.manual || o.crop === 'on') ? s.q : null;
    if (!s && o.crop === 'on') q = detectQuad(c);
    const full = q && q.every((p, j) => Math.abs(p[0] - [0, 1, 1, 0][j]) < 0.005 && Math.abs(p[1] - [0, 0, 1, 1][j]) < 0.005);
    if (q && !full) { st(T('Straightening page') + ' ' + (i + 1) + '…', (i + 0.4) / files.length); await tick(); c = warpQuad(c, q); }
    c = docFilter(c, o.filter);
    const img = await pdf.embedJpg(await jpegBytes(c, 0.85));
    const [pw, ph] = o.page === 'fit' ? [c.width * 0.75, c.height * 0.75] : (c.width > c.height ? [A4[1], A4[0]] : A4);
    const page = pdf.addPage([pw, ph]);
    const m = o.page === 'fit' ? 0 : 14, k = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
    page.drawImage(img, { x: (pw - img.width * k) / 2, y: (ph - img.height * k) / 2, width: img.width * k, height: img.height * k });
  }
  return [{ name: 'scan-' + new Date().toISOString().slice(0, 10) + '.pdf', blob: pdfBlob(await pdf.save()), info: files.length + ' page' + (files.length > 1 ? 's' : '') }];
}
async function runImgToPdf(files, o, st) {
  await load('pdflib');
  const pdf = await PDFLib.PDFDocument.create();
  const m = +o.margin;
  for (let i = 0; i < files.length; i++) {
    st(T('Adding image') + ' ' + (i + 1) + ' / ' + files.length + '…', i / files.length); await tick();
    const c = await fileToCanvas(files[i], 1, '#ffffff', LIMITS.docSide);
    const img = await pdf.embedJpg(await jpegBytes(c, 0.92));
    let pw, ph;
    if (o.page === 'fit') { pw = c.width * 0.75 + 2 * m; ph = c.height * 0.75 + 2 * m; }
    else { [pw, ph] = c.width > c.height ? [A4[1], A4[0]] : A4; }
    const page = pdf.addPage([pw, ph]);
    const k = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height);
    page.drawImage(img, { x: (pw - img.width * k) / 2, y: (ph - img.height * k) / 2, width: img.width * k, height: img.height * k });
  }
  return [{ name: files.length === 1 ? base(files[0].name) + '.pdf' : 'images.pdf', blob: pdfBlob(await pdf.save()) }];
}

async function runPdfToImg(files, o, st) {
  const out = [], mime = o.fmt === 'png' ? 'image/png' : 'image/jpeg';
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    const doc = await openPdfJs(f);
    for (let i = 1; i <= doc.numPages; i++) {
      st(f.name + ': ' + T('page') + ' ' + i + ' / ' + doc.numPages + '…', (fi + i / doc.numPages) / files.length);
      const c = await renderPdfPage(doc, i, +o.scale);
      out.push({ name: base(f.name) + '-page-' + i + '.' + o.fmt, blob: await canvasToBlob(c, mime, 0.92), info: c.width + '×' + c.height + ' px' });
      c.width = c.height = 0;
    }
    closePdf(doc);
  }
  return out;
}

async function runWordToPdf(files, o, st) {
  if (o.mode === 'print') return printDocx(files[0], st);
  await load('pdflib');
  const out = [];
  for (const f of files) {
    const pages = await docxToPages(f, st);
    st(T('Building PDF…'), 0.97);
    const pdf = await PDFLib.PDFDocument.create();
    const font = await pdf.embedFont(PDFLib.StandardFonts.Helvetica);
    for (const { canvas, words } of pages) {
      const img = await pdf.embedJpg(await jpegBytes(canvas, 0.9));
      const p = pdf.addPage(A4);
      p.drawImage(img, { x: 0, y: 0, width: A4[0], height: A4[1] });
      // Invisible text layer → text can be selected, copied and searched
      const k = A4[0] / 794;
      for (const w of words) {
        const t = w.t.replace(/[^\x20-\x7E -ÿ]/g, '');
        if (!t) continue;
        try {
          const w1 = font.widthOfTextAtSize(t, 1); if (!w1) continue;
          const size = Math.max(1, Math.min((w.w * k) / w1, w.h * k * 1.3));
          p.drawText(t, { x: w.x * k, y: A4[1] - (w.y + w.h) * k + w.h * k * 0.22, size, font, opacity: 0 });
        } catch (e) { /* character not supported by the built-in font – skip */ }
      }
    }
    out.push({ name: base(f.name) + '.pdf', blob: pdfBlob(await pdf.save()), info: pages.length + ' page' + (pages.length > 1 ? 's' : '') });
  }
  return out;
}
/* Best quality: the browser's own "Save as PDF" – real, sharp text in every language */
async function printDocx(file, st) {
  if (inClaude) throw new Error('This mode works on the live website (it uses your browser’s Print → Save as PDF). Inside the Claude preview, use "Quick" mode.');
  if (!/\.docx$/i.test(file.name)) throw new Error('"' + file.name + '" is not a .docx file. Old .doc files are not supported – save it as .docx first.');
  await load('mammoth');
  st(T('Reading Word file…'), 0.3);
  const html = (await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value || '<p></p>';
  const css = [...document.styleSheets].map(() => '').join('');
  const fr = document.createElement('iframe'); fr.className = 'printframe'; fr.setAttribute('aria-hidden', 'true');
  document.body.appendChild(fr);
  const d = fr.contentDocument;
  d.open();
  d.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(base(file.name)) + '</title><style>' + css +
    '@page{size:A4;margin:19mm 20mm}body{margin:0;font:11pt/1.5 Calibri,Carlito,"Noto Sans","Noto Sans Devanagari",Arial,sans-serif;color:#000}p{margin:0 0 6pt}h1{font-size:18pt}h2{font-size:15pt}h3{font-size:13pt}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%;margin:0 0 8pt;page-break-inside:auto}tr{page-break-inside:avoid}td,th{border:1px solid #888;padding:3pt 5pt;vertical-align:top}ul,ol{margin:0 0 6pt;padding-left:20pt}</style></head><body>' + html + '</body></html>');
  d.close();
  await new Promise(r => setTimeout(r, 300));
  await Promise.all([...d.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
  st(T('Opening print window…'), 0.9);
  try { fr.contentWindow.focus(); fr.contentWindow.print(); }
  catch (e) { fr.remove(); throw new Error('Printing is blocked here. Use "Quick" mode instead.'); }
  setTimeout(() => fr.remove(), 60000);
  const out = []; out.msg = T('In the print window, choose "Save as PDF" as the printer, then tap Save / Download.');
  return out;
}
async function runWordToImg(files, o, st) {
  const out = [], mime = o.fmt === 'png' ? 'image/png' : 'image/jpeg';
  for (const f of files) {
    const pages = await docxToPages(f, st);
    for (let i = 0; i < pages.length; i++) out.push({ name: base(f.name) + '-page-' + (i + 1) + '.' + o.fmt, blob: await canvasToBlob(pages[i].canvas, mime, 0.92) });
  }
  return out;
}

async function pdfTextPages(doc, f, st) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    st(f.name + ': ' + T('page') + ' ' + i + ' / ' + doc.numPages + '…', i / doc.numPages);
    const tc = await (await doc.getPage(i)).getTextContent();
    let t = ''; for (const it of tc.items) if ('str' in it) t += it.str + (it.hasEOL ? '\n' : '');
    pages.push(t);
  }
  return pages;
}

async function runPdfToWord(files, o, st) {
  const out = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    let blocks;
    if (o.mode === 'ocr') {
      const w = await getOcr(o.lang, st); const texts = [];
      const total = await countPages([f]);
      for await (const src of ocrSources([f], st, () => texts.length / total)) {
        st(f.name + ': ' + T('recognising text on page') + ' ' + (texts.length + 1) + ' / ' + total + '…', (texts.length + 0.5) / total);
        texts.push((await w.recognize(prepForOcr(src.canvas), { rotateAuto: true })).data.text);
      }
      blocks = ocrTextToBlocks(texts);
    } else {
      const doc = await openPdfJs(f);
      blocks = [];
      if (o.mode === 'text') {
        let any = false;
        for (let i = 1; i <= doc.numPages; i++) {
          st(f.name + ': ' + T('page') + ' ' + i + ' / ' + doc.numPages + '…', (fi + i / doc.numPages) / files.length);
          const page = await doc.getPage(i);
          const pb = await pdfPageBlocks(page); page.cleanup();
          if (pb.length) any = true; else pb.push({ type: 'p', text: '' });
          pb[0].pageBreak = i > 1;
          blocks.push(...pb);
        }
        if (!any) { closePdf(doc); throw new Error('No text found in "' + f.name + '". It is probably a scanned PDF – choose "Scanned PDF (OCR)" or "Keep exact look".'); }
      } else {
        for (let i = 1; i <= doc.numPages; i++) {
          st(f.name + ': ' + T('page') + ' ' + i + ' / ' + doc.numPages + '…', (fi + i / doc.numPages) / files.length);
          const c = await renderPdfPage(doc, i, 2);
          blocks.push({ type: 'img', bytes: await jpegBytes(c, 0.88), ext: 'jpeg', w: c.width, h: c.height, pageBreak: i > 1 });
          c.width = c.height = 0;
        }
      }
      closePdf(doc);
    }
    st(T('Building Word file…'), 0.99);
    out.push({ name: base(f.name) + '.docx', blob: await buildDocx(blocks) });
  }
  return out;
}
async function runImgToWord(files, o, st) {
  const blocks = [];
  for (let i = 0; i < files.length; i++) {
    st(T('Adding image') + ' ' + (i + 1) + ' / ' + files.length + '…', i / files.length); await tick();
    const c = await fileToCanvas(files[i], 1, '#ffffff', LIMITS.docSide);
    blocks.push({ type: 'img', bytes: await jpegBytes(c, 0.92), ext: 'jpeg', w: c.width, h: c.height, pageBreak: o.layout === 'page' && i > 0 });
  }
  st(T('Building Word file…'), 0.97);
  return [{ name: files.length === 1 ? base(files[0].name) + '.docx' : 'images.docx', blob: await buildDocx(blocks) }];
}

async function runPdfToText(files, o, st) {
  const out = [];
  for (const f of files) {
    const pdoc = await openPdfJs(f); const pages = await pdfTextPages(pdoc, f, st); closePdf(pdoc);
    const txt = pages.join('\n\n').trim();
    if (!txt) throw new Error('No text found in "' + f.name + '". It is probably a scanned PDF – use the OCR tool instead.');
    out.push({ name: base(f.name) + '.txt', blob: new Blob([txt + '\n'], { type: 'text/plain' }) });
  }
  return out;
}

async function runOcr(files, o, st) {
  const w = await getOcr(o.lang, st);
  const texts = [], pdfs = [];
  let n = 0;
  const total = await countPages(files);
  for await (const src of ocrSources(files, st, () => n / total)) {
    n++; st(T('Recognising text: page') + ' ' + n + ' / ' + total + '…', (n - 0.5) / total);
    const r = await w.recognize(prepForOcr(src.canvas), { rotateAuto: true }, { text: true, pdf: o.out === 'pdf' });
    texts.push(r.data.text || '');
    if (o.out === 'pdf') pdfs.push(Uint8Array.from(r.data.pdf));
  }
  if (!texts.join('').trim() && o.out !== 'pdf') throw new Error('No text could be recognised. Try a clearer, straighter photo, or pick the right language.');
  const nm = files.length === 1 ? base(files[0].name) : 'ocr';
  if (o.out === 'txt') return [{ name: nm + '-text.txt', blob: new Blob([texts.map(t => ocrTextToBlocks([t]).map(b => b.text).join('\n\n')).join('\n\n').trim() + '\n'], { type: 'text/plain' }) }];
  if (o.out === 'docx') return [{ name: nm + '-text.docx', blob: await buildDocx(ocrTextToBlocks(texts)) }];
  await load('pdflib');
  st(T('Building searchable PDF…'), 0.98);
  const outPdf = await PDFLib.PDFDocument.create();
  for (const b of pdfs) { const d = await PDFLib.PDFDocument.load(b); (await outPdf.copyPages(d, d.getPageIndices())).forEach(p => outPdf.addPage(p)); }
  return [{ name: nm + '-searchable.pdf', blob: pdfBlob(await outPdf.save()), info: n + ' page' + (n > 1 ? 's' : '') }];
}
async function countPages(files) {
  let n = 0;
  for (const f of files) {
    if (isPdf(f)) { try { const d = await openPdfJs(f); n += d.numPages; closePdf(d); } catch (e) { n += 1; } }
    else n++;
  }
  return Math.max(1, n);
}
/* Smart compression: shrink and re-encode only the pictures inside the PDF – text stays sharp and selectable */
async function smartCompress(file, maxSide, q, st, label, frac0, fracSpan) {
  await load('pdflib');
  const { PDFName, PDFRawStream, PDFArray, PDFRef, decodePDFRawStream } = PDFLib;
  const doc = await openPdfLib(file);
  const ctx = doc.context;
  const N = name => PDFName.of(name);
  const imgs = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(N('Subtype')) === N('Image'));
  let done = 0, changed = 0;
  for (const [ref, obj] of imgs) {
    done++;
    if (done % 3 === 1) { st(label + ' ' + T('image') + ' ' + done + ' / ' + imgs.length + '…', frac0 + fracSpan * done / imgs.length); await tick(); }
    try {
      const dict = obj.dict, L = k => ctx.lookup(dict.get(N(k)));
      if (dict.get(N('ImageMask')) || dict.get(N('Decode')) || dict.get(N('Mask'))) continue;
      const w = L('Width').asNumber(), h = L('Height').asNumber(), bpc = L('BitsPerComponent') ? L('BitsPerComponent').asNumber() : 8;
      if (w * h < 40000) continue;
      const fl = L('Filter'); const filters = fl instanceof PDFArray ? fl.asArray().map(x => ctx.lookup(x).toString()) : fl ? [fl.toString()] : [];
      const cs = L('ColorSpace'); let csName = cs instanceof PDFName ? cs.toString() : null;
      if (cs instanceof PDFArray && ctx.lookup(cs.get(0)) === N('ICCBased')) { // ICC colour profile: treat as plain RGB / gray
        const icc = ctx.lookup(cs.get(1)); const nc = icc && icc.dict && ctx.lookup(icc.dict.get(N('N')));
        csName = nc && nc.asNumber() === 3 ? '/DeviceRGB' : nc && nc.asNumber() === 1 ? '/DeviceGray' : null;
      }
      if (csName !== '/DeviceRGB' && csName !== '/DeviceGray') continue;
      const smask = dict.get(N('SMask'));
      let c;
      if (filters.length === 1 && filters[0] === '/DCTDecode') {
        const url = URL.createObjectURL(new Blob([obj.contents], { type: 'image/jpeg' }));
        try { const im = new Image(); im.src = url; await im.decode(); c = newCanvas(im.naturalWidth, im.naturalHeight); c.getContext('2d').drawImage(im, 0, 0); }
        finally { URL.revokeObjectURL(url); }
      } else if (filters.length === 1 && filters[0] === '/FlateDecode' && bpc === 8 && !dict.get(N('DecodeParms'))) {
        const raw = decodePDFRawStream(obj).decode(); const comps = csName === '/DeviceRGB' ? 3 : 1;
        if (raw.length < w * h * comps) continue;
        c = newCanvas(w, h); const cx = c.getContext('2d'); const id = cx.createImageData(w, h); const dd = id.data;
        for (let i = 0, j = 0; i < w * h; i++, j += comps) { dd[i * 4] = raw[j]; dd[i * 4 + 1] = raw[j + (comps - 1 ? 1 : 0)]; dd[i * 4 + 2] = raw[j + (comps - 1 ? 2 : 0)]; dd[i * 4 + 3] = 255; }
        cx.putImageData(id, 0, 0);
      } else continue;
      let k = smask ? 1 : Math.min(1, maxSide / Math.max(c.width, c.height));
      let target = c;
      if (k < 1) { target = newCanvas(c.width * k, c.height * k, '#ffffff'); const tx = target.getContext('2d'); tx.imageSmoothingQuality = 'high'; tx.drawImage(c, 0, 0, target.width, target.height); }
      const bytes = await jpegBytes(target, q);
      if (bytes.length >= obj.contents.length * 0.9) continue;
      const nd = { Type: 'XObject', Subtype: 'Image', Width: target.width, Height: target.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' };
      if (smask instanceof PDFRef) nd.SMask = smask;
      ctx.assign(ref, ctx.stream(bytes, nd));
      changed++;
      c.width = c.height = 0;
    } catch (e) { /* unusual image – leave it unchanged */ }
  }
  return { bytes: await doc.save({ useObjectStreams: true }), changed, images: imgs.length };
}
const SMART_LADDER = [[2400, 0.8], [2000, 0.72], [1700, 0.66], [1400, 0.58], [1150, 0.5], [950, 0.42], [800, 0.36], [650, 0.3]];
const COMPRESS_LADDER = [[2.0, 0.8], [1.7, 0.72], [1.4, 0.64], [1.15, 0.56], [0.95, 0.48], [0.8, 0.42], [0.65, 0.35], [0.5, 0.3]];
async function rasterisePdf(doc, scale, q, st, label) {
  const pdf = await PDFLib.PDFDocument.create();
  for (let i = 1; i <= doc.numPages; i++) {
    st(label + ' ' + T('page') + ' ' + i + ' / ' + doc.numPages + '…', i / doc.numPages);
    const c = await renderPdfPage(doc, i, scale);
    const img = await pdf.embedJpg(await jpegBytes(c, q));
    const p = pdf.addPage(c._pt);
    p.drawImage(img, { x: 0, y: 0, width: c._pt[0], height: c._pt[1] });
    c.width = c.height = 0;
  }
  return pdf.save();
}
async function runCompress(files, o, st) {
  await load('pdflib');
  const out = [];
  const lvl = { low: 0, medium: 2, strong: 4, extreme: 6 }[o.level];
  for (const f of files) {
    const target = (parseFloat(o.target) || 0) * 1024;
    let bytes = null, how = '';
    if (o.method !== 'image') {
      if (target) {
        for (let i = 1; i < SMART_LADDER.length; i += 2) {
          const r = await smartCompress(f, SMART_LADDER[i][0], SMART_LADDER[i][1], st, T('Try') + ' ' + ((i + 1) / 2) + ':', 0, 0.5);
          if (!bytes || r.bytes.length < bytes.length) bytes = r.bytes;
          if (bytes.length <= target || !r.images) break;
        }
        how = T('text kept');
      } else {
        const r = await smartCompress(f, SMART_LADDER[lvl][0], SMART_LADDER[lvl][1], st, T('Compressing'), 0, 1);
        bytes = r.bytes; how = r.images ? T('text kept') : T('no pictures to shrink');
      }
    }
    if (o.method === 'image' || (target && bytes.length > target)) {
      const doc = await openPdfJs(f);
      if (target) {
        let idx = 1;
        while (true) {
          const [s, q] = COMPRESS_LADDER[idx];
          const b = await rasterisePdf(doc, s, q, st, T('Try') + ' ' + idx + ':');
          if (!bytes || b.length < bytes.length) { bytes = b; how = T('pages turned into images'); }
          if (b.length <= target || idx === COMPRESS_LADDER.length - 1) break;
          idx++;
        }
      } else { bytes = await rasterisePdf(doc, ...COMPRESS_LADDER[lvl], st, T('Compressing')); how = T('pages turned into images'); }
      closePdf(doc);
    }
    let info, blob = pdfBlob(bytes);
    if (bytes.length >= f.size * 0.98) { blob = f; info = T('Already well compressed – kept the original'); }
    else info = fmtSize(f.size) + ' → ' + fmtSize(bytes.length) + ' (−' + Math.round(100 - bytes.length / f.size * 100) + '%) · ' + how;
    if (target && blob.size > target) info += ' · ⚠️ ' + T('could not reach') + ' ' + o.target + ' KB';
    out.push({ name: base(f.name) + '-compressed.pdf', blob, info });
  }
  return out;
}

async function runMerge(files, o, st) {
  if (files.length < 2) throw new Error('Add at least 2 PDF files to merge.');
  await load('pdflib');
  const out = await PDFLib.PDFDocument.create();
  for (let i = 0; i < files.length; i++) {
    st(T('Merging') + ' ' + (i + 1) + ' / ' + files.length + '…', i / files.length);
    const src = await openPdfLib(files[i]);
    (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
  }
  return [{ name: 'merged.pdf', blob: pdfBlob(await out.save()), info: out.getPageCount() + ' pages' }];
}

async function runSplit(files, o, st) {
  const out = [];
  for (const f of files) {
    const src = await openPdfLib(f), n = src.getPageCount();
    let groups;
    if (o.mode === 'each') groups = [...Array(n).keys()].map(i => ({ label: String(i + 1), idx: [i] }));
    else if (o.mode === 'groups') { if (!o.range.trim()) throw new Error('Enter page ranges, e.g. 1-3, 4-6'); groups = rangeGroups(o.range, n); }
    else { if (!o.range.trim()) throw new Error('Enter the pages to extract, e.g. 1-3, 5'); groups = [{ label: o.range.replace(/\s+/g, ''), idx: parsePages(o.range, n) }]; }
    for (let g = 0; g < groups.length; g++) {
      st(f.name + ': ' + T('file') + ' ' + (g + 1) + ' / ' + groups.length + '…', g / groups.length);
      const d = await PDFLib.PDFDocument.create();
      (await d.copyPages(src, groups[g].idx)).forEach(p => d.addPage(p));
      out.push({ name: base(f.name) + '-pages-' + groups[g].label.replace(/,/g, '_') + '.pdf', blob: pdfBlob(await d.save()) });
    }
  }
  return out;
}

async function runPageNumbers(files, o, st) {
  await load('pdflib');
  const out = [];
  for (const f of files) {
    st('Numbering ' + f.name + '…');
    const d = await openPdfLib(f);
    const font = await d.embedFont(PDFLib.StandardFonts.Helvetica);
    const pages = d.getPages(), size = +o.size, start = parseInt(o.start, 10) || 1;
    const skip = o.skip === 'yes' ? 1 : 0, N = pages.length - skip + start - 1;
    pages.forEach((p, i) => {
      if (i < skip) return;
      const num = i - skip + start;
      const txt = { n: String(num), page: 'Page ' + num, of: num + ' / ' + N, pageof: 'Page ' + num + ' of ' + N }[o.fmt];
      const { width, height } = p.getSize(), tw = font.widthOfTextAtSize(txt, size), m = 24;
      const x = o.pos.endsWith('c') ? (width - tw) / 2 : o.pos.endsWith('r') ? width - m - tw : m;
      const y = o.pos.startsWith('t') ? height - m - size : m;
      p.drawText(txt, { x, y, size, font, color: PDFLib.rgb(0.2, 0.2, 0.2) });
    });
    out.push({ name: base(f.name) + '-numbered.pdf', blob: pdfBlob(await d.save()) });
  }
  return out;
}

/* Organize: visual page grid */
let orgToken = 0;
async function organizeLoad(keep) {
  if (keep === true && state.pages.length) { renderPageGrid(); return; }
  const box = $('#extra'); const my = ++orgToken; state.pages = [];
  box.innerHTML = '';
  const f = state.files[0] && state.files[0].file; if (!f) return;
  const st = m => setStatus(m, 'busy');
  try {
    st(T('Loading pages…'));
    const doc = await openPdfJs(f);
    for (let i = 1; i <= doc.numPages; i++) {
      if (my !== orgToken) return;
      const page = await doc.getPage(i); const v1 = page.getViewport({ scale: 1 });
      const c = await renderPdfPage(doc, i, Math.min(1, 240 / v1.width));
      state.pages.push({ src: i - 1, rot: 0, del: false, url: c.toDataURL('image/jpeg', 0.7) });
      if (i % 6 === 0 || i === doc.numPages) { renderPageGrid(); st(T('Loading pages…') + ' ' + i + '/' + doc.numPages); }
    }
    if (my === orgToken) setStatus(T('Tap the buttons under each page to rotate, delete or move it.'));
  } catch (e) { if (my === orgToken) setStatus(e.message, 'err'); }
}
function renderPageGrid() {
  const box = $('#extra'); if (!box) return;
  const P = state.pages, n = P.length;
  box.innerHTML = '<div class="pbar"><button class="chip" data-g="rotall">⟳ ' + esc(T('Rotate all')) + '</button><button class="chip" data-g="reset">↺ ' + esc(T('Reset')) + '</button><span class="mute">' + P.filter(p => !p.del).length + ' / ' + n + ' ' + esc(T('pages kept')) + '</span></div>' +
    '<div class="pgrid">' + P.map((p, i) => '<div class="pcard' + (p.del ? ' del' : '') + '"><div class="pthumb"><img src="' + p.url + '" style="transform:rotate(' + p.rot + 'deg)" alt=""></div>' +
      '<div class="pnum">' + (i + 1) + (p.src !== i ? ' <small>(' + (p.src + 1) + ')</small>' : '') + '</div>' +
      '<div class="pbtns"><button class="ib" data-p="l" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move left">←</button><button class="ib" data-p="r" data-i="' + i + '" aria-label="Rotate">⟳</button>' +
      '<button class="ib' + (p.del ? ' on' : '') + '" data-p="d" data-i="' + i + '" aria-label="Delete">' + (p.del ? '↺' : '🗑') + '</button><button class="ib" data-p="m" data-i="' + i + '"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="Move right">→</button></div></div>').join('') + '</div>';
  box.querySelectorAll('[data-p]').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, a = b.dataset.p;
    if (a === 'r') P[i].rot = (P[i].rot + 90) % 360;
    else if (a === 'd') P[i].del = !P[i].del;
    else if (a === 'l') [P[i - 1], P[i]] = [P[i], P[i - 1]];
    else [P[i + 1], P[i]] = [P[i], P[i + 1]];
    renderPageGrid();
  });
  box.querySelectorAll('[data-g]').forEach(b => b.onclick = () => {
    if (b.dataset.g === 'rotall') P.forEach(p => p.rot = (p.rot + 90) % 360);
    else { P.sort((x, y) => x.src - y.src); P.forEach(p => { p.rot = 0; p.del = false; }); }
    renderPageGrid();
  });
}
async function runOrganize(files, o, st) {
  const P = state.pages || [];
  if (!P.length) throw new Error('Pages are still loading – please wait a moment.');
  const keep = P.filter(p => !p.del);
  if (!keep.length) throw new Error('You cannot delete every page.');
  st(T('Saving changes…'), 0.5);
  const src = await openPdfLib(files[0]);
  const d = await PDFLib.PDFDocument.create();
  const copied = await d.copyPages(src, keep.map(p => p.src));
  copied.forEach((pg, i) => { pg.setRotation(PDFLib.degrees((pg.getRotation().angle + keep[i].rot) % 360)); d.addPage(pg); });
  return [{ name: base(files[0].name) + '-organized.pdf', blob: pdfBlob(await d.save()), info: keep.length + ' pages' }];
}

/* ---------- Tool catalogue ---------- */
const IMG_ACCEPT = 'image/*,.heic,.heif';
const PDF_ACCEPT = 'application/pdf,.pdf';
const DOCX_ACCEPT = '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SECTIONS = [
  { id: 'img', title: 'Image tools', color: 'var(--img)' },
  { id: 'conv', title: 'Convert between formats', color: 'var(--conv)' },
  { id: 'pdf', title: 'PDF tools', color: 'var(--pdf)' }
];
const fmtImgOpt = { k: 'fmt', label: 'Image format', type: 'select', options: [['jpg', 'JPG'], ['png', 'PNG']] };
const OCR_LANG = { k: 'lang', label: 'Text language', type: 'select', options: [['eng', 'English'], ['eng+hin', 'English + Hindi'], ['eng+guj', 'English + Gujarati'], ['hin', 'Hindi'], ['guj', 'Gujarati']] };
const TOOLS = [
  { id: 'image-convert', libs: ['heic', 'jszip'], cat: 'img', badge: 'JPG ⇄ PNG ⇄ WEBP', title: 'Convert image', desc: 'JPG, PNG, WebP and iPhone HEIC. Resize and compress too.', seo: 'JPG to PNG, PNG to JPG, HEIC to JPG Converter', accept: IMG_ACCEPT, hint: 'JPG, PNG, WebP, HEIC, GIF, BMP', multi: true, btn: 'Convert images',
    opts: [{ k: 'fmt', label: 'Convert to', type: 'select', options: [['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']] }, { k: 'q', label: 'Quality', type: 'range', min: 10, max: 100, val: 90, unit: '%', hint: 'Lower = smaller file (JPG/WebP only)' }, { k: 'scale', label: 'Resize', type: 'range', min: 10, max: 100, val: 100, unit: '%' }], run: runImgConvert },
  { id: 'image-resize', libs: ['heic'], cat: 'img', badge: 'PX · KB', title: 'Resize image to exact size / KB', desc: 'Exact pixels or under a KB limit – for exam and job forms.', seo: 'Resize Image to 20 KB, 50 KB, 100 KB – Photo & Signature Resizer', accept: IMG_ACCEPT, hint: 'Photo, signature or any image', multi: true, btn: 'Resize',
    opts: [{ k: 'preset', label: 'Quick preset', type: 'select', options: [['custom', 'Custom'], ['passport', 'Passport photo 3.5×4.5 cm (413×531 px)'], ['photo50', 'Photo 200×230 px, 10–50 KB'], ['sign20', 'Signature 140×60 px, under 20 KB'], ['kb100', 'Under 100 KB (keep proportions)'], ['kb50', 'Under 50 KB (keep proportions)'], ['kb20', 'Under 20 KB (keep proportions)']], hint: 'Always check your form’s own size rules' },
      { k: 'w', label: 'Width (px)', type: 'num', ph: 'auto' }, { k: 'h', label: 'Height (px)', type: 'num', ph: 'auto' },
      { k: 'fit', label: 'If both width and height are set', type: 'select', options: [['crop', 'Crop to fill (no borders)'], ['fit', 'Fit inside (white borders)'], ['stretch', 'Stretch']] },
      { k: 'max', label: 'Max size (KB)', type: 'num', ph: 'no limit' }, { k: 'min', label: 'Min size (KB)', type: 'num', ph: 'none' },
      { k: 'fmt', label: 'Format', type: 'select', options: [['jpg', 'JPG'], ['png', 'PNG']], hint: 'A KB limit always saves as JPG' }], run: runResize, onOpt: applyPreset },
  { id: 'scan-to-pdf', libs: ['pdflib'], onFiles: scanLoad, cat: 'img', badge: 'CAMERA → PDF', title: 'Scan document to PDF', desc: 'Photograph pages – auto-crop and clean them into a PDF.', seo: 'Scan Document to PDF with Phone Camera', accept: 'image/*', hint: 'Take a photo of each page, or pick from gallery', multi: true, camera: true, btn: 'Create PDF',
    opts: [{ k: 'crop', label: 'Auto-crop & straighten', type: 'select', options: [['on', 'On'], ['off', 'Off (unless adjusted)']] }, { k: 'filter', label: 'Look', type: 'select', options: [['enhance', 'Enhanced (white background)'], ['bw', 'Black & white'], ['gray', 'Grayscale'], ['original', 'Original colour']] }, { k: 'page', label: 'Page size', type: 'select', options: [['a4', 'A4'], ['fit', 'Same as photo']] }], run: runScan,
    note: 'Corners are found automatically – tap “Adjust corners” to fix any page. For best results, put the paper on a darker surface.' },
  { id: 'image-to-pdf', libs: ['pdflib', 'heic'], cat: 'conv', badge: 'IMG → PDF', title: 'Image to PDF', desc: 'Combine one or many photos into a single PDF.', seo: 'JPG to PDF Converter – Combine Images into PDF', accept: IMG_ACCEPT, hint: 'Add images in the order you want the pages', multi: true, btn: 'Create PDF',
    opts: [{ k: 'page', label: 'Page size', type: 'select', options: [['fit', 'Same as image'], ['a4', 'A4 (auto portrait / landscape)']] }, { k: 'margin', label: 'Margin', type: 'select', options: [['0', 'None'], ['20', 'Small'], ['40', 'Large']], hint: 'White space around the image on each page' }], run: runImgToPdf },
  { id: 'pdf-to-image', libs: ['pdfjs', 'jszip'], cat: 'conv', badge: 'PDF → IMG', title: 'PDF to Image', desc: 'Turn every page of a PDF into a JPG or PNG.', seo: 'PDF to JPG Converter', accept: PDF_ACCEPT, hint: 'PDF files', multi: true, btn: 'Convert to images',
    opts: [fmtImgOpt, { k: 'scale', label: 'Quality', type: 'select', options: [['2', 'High (recommended)'], ['1.25', 'Normal'], ['3', 'Very high (large files)']] }], run: runPdfToImg },
  { id: 'word-to-pdf', libs: ['mammoth', 'h2c', 'pdflib'], cat: 'conv', badge: 'DOCX → PDF', title: 'Word to PDF', desc: 'Convert .docx documents to PDF with selectable text.', seo: 'Word to PDF Converter (DOCX to PDF)', accept: DOCX_ACCEPT, hint: '.docx files', multi: true, btn: 'Convert to PDF', run: runWordToPdf,
    opts: [{ k: 'mode', label: 'Quality', type: 'select', options: [['quick', 'Quick – direct download'], ['print', 'Best – real text (Print → Save as PDF)']], hint: 'Best mode gives sharp, selectable text in every language. It opens your browser’s print window – choose “Save as PDF”. One file at a time.' }],
    note: 'Text, headings, lists, tables and images are kept. Quick mode: pages are pictures with selectable English text. Best mode: real text in any language, smaller file. Complex layouts (columns, text boxes, headers/footers) may look different.' },
  { id: 'pdf-to-word', libs: ['pdfjs', 'jszip'], cat: 'conv', badge: 'PDF → DOCX', title: 'PDF to Word', desc: 'Editable text (even from scans), or keep the exact look.', seo: 'PDF to Word Converter (PDF to DOCX)', accept: PDF_ACCEPT, hint: 'PDF files', multi: true, btn: 'Convert to Word',
    opts: [{ k: 'mode', label: 'Mode', type: 'select', options: [['text', 'Editable text (normal PDF)'], ['ocr', 'Editable text (scanned PDF – OCR)'], ['image', 'Keep exact look (pages as pictures)']] }, OCR_LANG], run: runPdfToWord,
    note: 'Editable text gets the words but not the layout. OCR is slower and needs a one-time download of language data.' },
  { id: 'ocr', libs: ['tess', 'pdfjs', 'jszip'], cat: 'conv', badge: 'OCR', title: 'OCR – scan to text', desc: 'Read text from photos or scanned PDFs. English, Hindi, Gujarati.', seo: 'OCR Online – Image to Text, Scanned PDF to Text (Hindi, Gujarati)', accept: IMG_ACCEPT + ',' + PDF_ACCEPT, hint: 'Images or scanned PDFs', multi: true, btn: 'Recognise text',
    opts: [OCR_LANG, { k: 'out', label: 'Save as', type: 'select', options: [['docx', 'Word (.docx)'], ['txt', 'Text (.txt)'], ['pdf', 'Searchable PDF']] }], run: runOcr,
    note: 'First use downloads the OCR engine and language data (about 2–15 MB). Clear, straight photos work best.' },
  { id: 'word-to-image', libs: ['mammoth', 'h2c', 'jszip'], cat: 'conv', badge: 'DOCX → IMG', title: 'Word to Image', desc: 'Each page of a .docx becomes an image.', seo: 'Word to JPG Converter', accept: DOCX_ACCEPT, hint: '.docx files', multi: true, btn: 'Convert to images', opts: [fmtImgOpt], run: runWordToImg },
  { id: 'image-to-word', libs: ['jszip', 'heic'], cat: 'conv', badge: 'IMG → DOCX', title: 'Image to Word', desc: 'Put photos into a Word document.', seo: 'JPG to Word Converter', accept: IMG_ACCEPT, hint: 'Add images in the order you want', multi: true, btn: 'Create Word file',
    opts: [{ k: 'layout', label: 'Layout', type: 'select', options: [['page', 'One image per page'], ['flow', 'One after another']] }], run: runImgToWord,
    note: 'This places the pictures in Word. To get editable text from a photo, use the OCR tool.' },
  { id: 'pdf-to-text', libs: ['pdfjs'], cat: 'conv', badge: 'PDF → TXT', title: 'PDF to Text', desc: 'Pull all the text out of a PDF.', seo: 'PDF to Text Converter', accept: PDF_ACCEPT, hint: 'PDF files', multi: true, btn: 'Extract text', run: runPdfToText },
  { id: 'compress-pdf', libs: ['pdflib', 'pdfjs'], cat: 'pdf', badge: 'COMPRESS', title: 'Compress PDF', desc: 'Make PDFs smaller – choose a level or a target KB.', seo: 'Compress PDF to 100 KB, 200 KB, 500 KB', accept: PDF_ACCEPT, hint: 'PDF files', multi: true, btn: 'Compress PDF',
    opts: [{ k: 'method', label: 'Method', type: 'select', options: [['smart', 'Smart – keep text sharp (recommended)'], ['image', 'Maximum – turn pages into images']] }, { k: 'level', label: 'Compression', type: 'select', options: [['medium', 'Medium (recommended)'], ['low', 'Low (best quality)'], ['strong', 'Strong'], ['extreme', 'Extreme (smallest)']] }, { k: 'target', label: 'Or target size (KB)', type: 'num', ph: 'e.g. 200', hint: 'If filled, the level above is ignored' }], run: runCompress,
    note: 'Smart mode shrinks only the pictures inside the PDF, so text stays sharp and selectable. If a target KB cannot be reached that way, pages are turned into images (text can then no longer be selected). Keep your original file.' },
  { id: 'merge-pdf', libs: ['pdflib'], cat: 'pdf', badge: 'MERGE', title: 'Merge PDFs', desc: 'Join several PDFs into one, in your order.', seo: 'Merge PDF Files', accept: PDF_ACCEPT, hint: 'Add 2 or more PDFs – use ↑ ↓ to reorder', multi: true, btn: 'Merge PDFs', run: runMerge },
  { id: 'split-pdf', libs: ['pdflib', 'jszip'], cat: 'pdf', badge: 'SPLIT', title: 'Split / extract pages', desc: 'Take out pages or split into separate files.', seo: 'Split PDF – Extract Pages', accept: PDF_ACCEPT, hint: 'PDF file', multi: false, btn: 'Split PDF',
    opts: [{ k: 'mode', label: 'Mode', type: 'select', options: [['extract', 'Extract pages into one PDF'], ['groups', 'Each range as a separate PDF'], ['each', 'Every page as a separate PDF']] }, { k: 'range', label: 'Pages', type: 'text', ph: 'e.g. 1-3, 5, 8-10', hint: 'Not needed for "every page"' }], run: runSplit },
  { id: 'organize-pdf', libs: ['pdflib', 'pdfjs'], cat: 'pdf', badge: 'ROTATE · DELETE · REORDER', title: 'Organize pages', desc: 'See all pages – rotate, delete and reorder them.', seo: 'Rotate, Delete and Reorder PDF Pages', accept: PDF_ACCEPT, hint: 'PDF file', multi: false, btn: 'Save changes', run: runOrganize, onFiles: organizeLoad },
  { id: 'page-numbers', libs: ['pdflib'], cat: 'pdf', badge: '1 2 3', title: 'Add page numbers', desc: 'Number the pages of a PDF.', seo: 'Add Page Numbers to PDF', accept: PDF_ACCEPT, hint: 'PDF files', multi: true, btn: 'Add numbers',
    opts: [{ k: 'pos', label: 'Position', type: 'select', options: [['bc', 'Bottom centre'], ['br', 'Bottom right'], ['bl', 'Bottom left'], ['tc', 'Top centre'], ['tr', 'Top right']] }, { k: 'fmt', label: 'Style', type: 'select', options: [['n', '1'], ['page', 'Page 1'], ['of', '1 / 10'], ['pageof', 'Page 1 of 10']] },
      { k: 'start', label: 'Start at', type: 'num', ph: '1' }, { k: 'skip', label: 'Skip first page (cover)', type: 'select', options: [['no', 'No'], ['yes', 'Yes']] }, { k: 'size', label: 'Text size', type: 'select', options: [['11', 'Normal'], ['9', 'Small'], ['14', 'Large']] }], run: runPageNumbers }
];
function applyPreset(k, el) {
  if (k !== 'preset') return;
  const p = RESIZE_PRESETS[el.value]; if (!p) return;
  for (const [key, v] of Object.entries(p)) { const f = document.querySelector('[data-k="' + key + '"]'); if (f) f.value = v; }
}

/* ---------- UI ---------- */
const state = { tool: null, files: [], results: [], busy: false, cancel: false, pages: [] };
let fid = 0, installEvt = null;
const BASE = document.body.dataset.base || '';
const PAGE_TOOL = document.body.dataset.tool || '';
const REAL_LINKS = !inClaude && /^https?:$/.test(location.protocol);
const toolHref = id => REAL_LINKS ? BASE + id + '/' : '#' + id;
class CancelError extends Error { constructor() { super('Cancelled'); this.cancelled = true; } }

/* Recently used tools (this browser only) */
function getRecent() { try { return JSON.parse(localStorage.getItem('pdfc-recent') || '[]').filter(id => TOOLS.some(t => t.id === id)); } catch (e) { return []; } }
function addRecent(id) { try { const r = [id, ...getRecent().filter(x => x !== id)].slice(0, 4); localStorage.setItem('pdfc-recent', JSON.stringify(r)); } catch (e) {} }

function langPicker() {
  return '<div class="langs" role="group" aria-label="Language">' + [['en', 'EN'], ['hi', 'हिंदी']].map(([k, l]) => '<button class="lang' + (k === LANG ? ' on' : '') + '" data-lang="' + k + '" aria-pressed="' + (k === LANG) + '">' + l + '</button>').join('') + '</div>';
}
function goHome() {
  if (PAGE_TOOL && REAL_LINKS) location.href = BASE || './';
  else location.hash = 'home';
}
function renderHeader(tool) {
  $('#hdr').innerHTML = '<div class="topbar">' + (tool ? '<button class="back" id="back">← ' + esc(T('All tools')) + '</button>' : '<span></span>') + langPicker() + '</div>' +
    (tool ? '<div class="logo"><i>⇄</i><h1>' + esc(T(tool.title)) + '</h1></div><p>' + esc(T(tool.desc)) + '</p>'
      : '<div class="logo"><i>⇄</i><h1>PDF Convert Free</h1></div><p>' + esc(T('Convert images, PDFs and Word files – free, fast and right on your phone.')) + '</p><span class="privacy">🔒 ' + esc(T('Files never leave your device')) + '</span>' +
        (installEvt ? ' <button class="privacy install" id="install">⬇ ' + esc(T('Install app')) + '</button>' : ''));
  const b = $('#back'); if (b) b.onclick = goHome;
  const ins = $('#install'); if (ins) ins.onclick = async () => { try { installEvt.prompt(); await installEvt.userChoice; } catch (e) {} installEvt = null; renderHeader(state.tool); };
  document.querySelectorAll('[data-lang]').forEach(x => x.onclick = () => {
    LANG = x.dataset.lang; try { localStorage.setItem('pdfc-lang', LANG); } catch (e) {}
    document.documentElement.lang = LANG; route(true);
  });
}
function setSeo(tool) {
  document.title = tool ? tool.seo + ' – Free & Private | PDF Convert Free' : 'PDF Convert Free – Image, PDF & Word Converter (JPG, PDF, DOCX, OCR)';
  const m = document.querySelector('meta[name=description]');
  if (m) m.content = tool ? tool.desc + ' Free, no upload – works in your browser.' : 'Free online converter: JPG to PDF, PDF to Word, Word to PDF, compress PDF, resize image to KB, OCR in Hindi. Files never leave your device.';
}

function card(t) {
  const s = SECTIONS.find(x => x.id === t.cat);
  return '<a class="card" href="' + toolHref(t.id) + '" data-id="' + t.id + '"><span class="badge" style="background:' + s.color + '">' + esc(t.badge) + '</span><b>' + esc(T(t.title)) + '</b><small>' + esc(T(t.desc)) + '</small></a>';
}
function renderHome() {
  state.tool = null; renderHeader(null); setSeo(null);
  const recent = getRecent().map(id => TOOLS.find(t => t.id === id));
  $('#main').innerHTML = '<div class="search"><input type="search" id="q" placeholder="' + esc(T('Search tools… e.g. compress, jpg, word')) + '" aria-label="' + esc(T('Search tools')) + '" autocomplete="off"></div>' +
    '<div id="homelist">' + (recent.length ? '<h2>' + esc(T('Recently used')) + '</h2><div class="grid">' + recent.map(card).join('') + '</div>' : '') +
    SECTIONS.map(s => '<h2>' + esc(T(s.title)) + '</h2><div class="grid">' + TOOLS.filter(t => t.cat === s.id).map(card).join('') + '</div>').join('') + '</div>' +
    '<div id="qres" hidden></div>';
  const q = $('#q');
  q.oninput = () => {
    const v = q.value.trim().toLowerCase();
    $('#homelist').hidden = !!v; const box = $('#qres'); box.hidden = !v;
    if (!v) return;
    const words = v.split(/\s+/);
    const hits = TOOLS.filter(t => { const hay = [t.title, t.desc, t.badge, t.seo, T(t.title), T(t.desc), t.id.replace(/-/g, ' ')].join(' ').toLowerCase(); return words.every(w => hay.includes(w)); });
    box.innerHTML = hits.length ? '<div class="grid">' + hits.map(card).join('') + '</div>' : '<p class="mute center">' + esc(T('No tool found. Try another word.')) + '</p>';
  };
}

function optField(o) {
  let f;
  const id = 'opt-' + o.k;
  if (o.type === 'select') f = '<select id="' + id + '" data-k="' + o.k + '">' + o.options.map(([v, l]) => '<option value="' + v + '">' + esc(T(l)) + '</option>').join('') + '</select>';
  else if (o.type === 'range') f = '<input id="' + id + '" type="range" data-k="' + o.k + '" min="' + o.min + '" max="' + o.max + '" value="' + o.val + '">';
  else if (o.type === 'num') f = '<input id="' + id + '" type="text" data-k="' + o.k + '" placeholder="' + esc(T(o.ph || '')) + '" inputmode="numeric" autocomplete="off">';
  else f = '<input id="' + id + '" type="text" data-k="' + o.k + '" placeholder="' + esc(T(o.ph || '')) + '" autocomplete="off">';
  const lab = o.type === 'range' ? esc(T(o.label)) + ': <span data-out="' + o.k + '">' + o.val + (o.unit || '') + '</span>' : esc(T(o.label));
  return '<div class="opt' + (o.hideIn && inClaude ? ' hide' : '') + '"><label for="' + id + '">' + lab + '</label>' + f + (o.hint ? '<div class="hint">' + esc(T(o.hint)) + '</div>' : '') + '</div>';
}

function renderTool(t, keep) {
  const prevFiles = keep ? state.files : [];
  const prevOpts = {}; if (keep) document.querySelectorAll('[data-k]').forEach(el => prevOpts[el.dataset.k] = el.value);
  state.tool = t; state.files = prevFiles; state.results = []; renderHeader(t); setSeo(t);
  if (!keep) { state.pages = []; orgToken++; addRecent(t.id); }
  const color = SECTIONS.find(s => s.id === t.cat).color;
  const opts = (t.opts || []).map(optField).join('');
  const pick = t.multi ? T('Tap to choose files') : T('Tap to choose a file');
  $('#main').innerHTML = '<div class="panel">' +
    (t.camera ? '<div class="pickrow"><label class="drop cam"><input type="file" id="fic" accept="image/*" capture="environment" hidden><b>📷 ' + esc(T('Take photo')) + '</b><small>' + esc(T('One page at a time')) + '</small></label>' +
      '<label class="drop" id="drop"><input type="file" id="fi" accept="' + t.accept + '" multiple hidden><b>🖼 ' + esc(T('From gallery')) + '</b><small>' + esc(T('or drag and drop')) + '</small></label></div>'
      : '<label class="drop" id="drop"><input type="file" id="fi" accept="' + t.accept + '"' + (t.multi ? ' multiple' : '') + ' hidden><b>' + esc(pick) + '</b><small>' + esc(T('or drag and drop here')) + ' · ' + esc(T(t.hint)) + '</small></label>') +
    '<ul class="flist" id="flist"></ul><div id="extra"></div>' +
    (opts ? '<div class="opts">' + opts + '</div>' : '') +
    '<button class="go" id="go" disabled style="background:' + color + '">' + esc(T(t.btn)) + '</button>' +
    '<div class="status" id="status" role="status" aria-live="polite"></div><div class="results" id="results"></div>' +
    (t.note ? '<div class="note">' + esc(T(t.note)) + '</div>' : '') + '</div>';
  for (const id of ['#fi', '#fic']) { const fi = $(id); if (fi) fi.onchange = () => { addFiles(fi.files); fi.value = ''; }; }
  const drop = $('#drop');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); };
  document.querySelectorAll('[data-k]').forEach(el => {
    if (prevOpts[el.dataset.k] !== undefined) el.value = prevOpts[el.dataset.k];
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      if (el.type === 'range') { const o = t.opts.find(x => x.k === el.dataset.k); $('[data-out="' + el.dataset.k + '"]').textContent = el.value + (o.unit || ''); }
      if (t.onOpt) t.onOpt(el.dataset.k, el);
      if (t.id === 'image-resize' && el.dataset.k !== 'preset') { const p = $('[data-k="preset"]'); if (p) p.value = 'custom'; }
    });
  });
  $('#go').onclick = run;
  renderFiles();
  if (keep && t.onFiles) t.onFiles(true);
  if (!keep) window.scrollTo(0, 0);
  // Start downloading this tool's libraries in the background so the first conversion starts faster
  setTimeout(() => (t.libs || []).forEach(k => load(k).catch(() => {})), 400);
}

function addFiles(list) {
  const t = state.tool; let arr = [...list];
  if (!arr.length) return;
  if (!t.multi) { arr = arr.slice(0, 1); state.files = []; }
  for (const f of arr) state.files.push({ id: ++fid, file: f });
  clearResults(); renderFiles();
  if (t.onFiles) t.onFiles();
}
function bigFileWarning() {
  const total = state.files.reduce((a, f) => a + f.file.size, 0) / 1048576;
  if (total <= LIMITS.warnMB) return '';
  const dev = IS_MOBILE ? T('this phone') : T('this device');
  return '<div class="warn">⚠️ ' + esc(T('Large file')) + ' (' + fmtSize(total * 1048576) + '). ' +
    esc(T('It may be slow or fail on')) + ' ' + esc(dev) + '. ' + esc(T('Tip: split the PDF or use a laptop/computer.')) + '</div>';
}
function renderFiles() {
  const ul = $('#flist'); const n = state.files.length;
  const warn = n ? bigFileWarning() : '';
  ul.innerHTML = state.files.map((f, i) => '<li><span class="nm">' + esc(f.file.name) + '</span><span class="sz">' + fmtSize(f.file.size) + '</span>' +
    (state.tool.multi && n > 1 ? '<button class="ib" data-a="up" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button><button class="ib" data-a="dn" data-i="' + i + '"' + (i === n - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' : '') +
    '<button class="ib" data-a="rm" data-i="' + i + '" aria-label="Remove">✕</button></li>').join('') + (warn ? '<li class="wli">' + warn + '</li>' : '');
  ul.querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, F = state.files;
    if (b.dataset.a === 'rm') F.splice(i, 1);
    else if (b.dataset.a === 'up') [F[i - 1], F[i]] = [F[i], F[i - 1]];
    else [F[i + 1], F[i]] = [F[i], F[i + 1]];
    clearResults(); renderFiles();
    if (state.tool.onFiles) state.tool.onFiles();
  });
  $('#go').disabled = !n || state.busy;
}
function setStatus(msg, kind, frac) {
  const s = $('#status'); if (!s) return;
  s.className = 'status' + (kind === 'err' ? ' err' : '') + (kind === 'busy' ? ' busy' : '');
  if (kind === 'busy') {
    const pct = frac == null ? null : Math.max(2, Math.min(100, Math.round(frac * 100)));
    s.innerHTML = '<div class="prow"><span class="spin"></span><span class="pmsg">' + esc(msg) + '</span>' + (pct != null ? '<b class="ppct">' + pct + '%</b>' : '') +
      '<button class="cancel" id="cancel">' + esc(T('Cancel')) + '</button></div><div class="pbarw"><div class="pbarf' + (pct == null ? ' ind' : '') + '" style="width:' + (pct == null ? 35 : pct) + '%"></div></div>';
    $('#cancel').onclick = () => { state.cancel = true; setStatus(T('Stopping…'), 'busy', frac); };
    return;
  }
  s.innerHTML = msg ? (kind === 'err' ? '⚠️ ' : kind === 'ok' ? '✅ ' : '') + '<span>' + esc(msg) + '</span>' : '';
}
function clearResults() {
  state.results.forEach(r => r.url && URL.revokeObjectURL(r.url));
  state.results = []; const r = $('#results'); if (r) r.innerHTML = ''; setStatus('');
}

async function run() {
  const t = state.tool; if (!state.files.length || state.busy) return;
  const o = {}; document.querySelectorAll('[data-k]').forEach(el => o[el.dataset.k] = el.value);
  clearResults(); state.busy = true; state.cancel = false; $('#go').disabled = true;
  let last = null;
  const st = (m, frac) => {
    if (state.cancel) throw new CancelError();
    if (frac != null) last = frac;
    if (state.tool === t) setStatus(m, 'busy', frac != null ? frac : last);
  };
  st(T('Starting…'));
  try {
    const out = await t.run(state.files.map(f => f.file), o, st);
    if (state.tool !== t) return;
    if (state.cancel) throw new CancelError();
    state.results = out;
    showResults();
    setStatus(out.msg || (T('Done!') + ' ' + out.length + ' ' + T(out.length > 1 ? 'files ready' : 'file ready')), 'ok');
  } catch (e) {
    if (state.tool !== t) return;
    if (e && e.cancelled) { setStatus(T('Cancelled.')); return; }
    console.error(e);
    setStatus((e && e.message) || 'Something went wrong.', 'err');
  } finally {
    state.busy = false; state.cancel = false; if (state.tool === t && $('#go')) $('#go').disabled = !state.files.length;
  }
}

/* ---------- Results: preview, share, save ---------- */
const EXT_COLOR = { pdf: '#dc2626', docx: '#2563eb', txt: '#475569', zip: '#18202f' };
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', zip: 'application/zip' };
function canShareFile(r) {
  if (inClaude || !navigator.canShare) return false;
  try { return navigator.canShare({ files: [new File([r.blob], r.name, { type: MIME[r.name.split('.').pop().toLowerCase()] || r.blob.type })] }); } catch (e) { return false; }
}
async function shareFile(r) {
  try { await navigator.share({ files: [new File([r.blob], r.name, { type: MIME[r.name.split('.').pop().toLowerCase()] || r.blob.type })], title: r.name }); }
  catch (e) { if (e && e.name !== 'AbortError') toast(T('Sharing is not available here – use Save.')); }
}
function showResults() {
  const box = $('#results'); const R = state.results;
  box.innerHTML = R.map((r, i) => {
    const ext = r.name.split('.').pop().toLowerCase();
    let thumb;
    if (/^(jpg|png|webp)$/.test(ext)) { r.url = r.url || URL.createObjectURL(r.blob); thumb = '<img src="' + r.url + '" alt="">'; }
    else thumb = '<span class="ic" style="background:' + (EXT_COLOR[ext] || '#64748b') + '">' + ext.toUpperCase() + '</span>';
    const canPrev = /^(jpg|png|webp|pdf|docx|txt)$/.test(ext);
    return '<div class="res">' + thumb + '<div class="meta"><div>' + esc(r.name) + '</div><small>' + fmtSize(r.blob.size) + (r.info ? ' · ' + esc(r.info) : '') + '</small></div>' +
      '<div class="ract">' + (canPrev ? '<button class="rb" data-pv="' + i + '" aria-label="' + esc(T('Preview')) + '" title="' + esc(T('Preview')) + '">👁</button>' : '') +
      (canShareFile(r) ? '<button class="rb" data-sh="' + i + '" aria-label="' + esc(T('Share')) + '" title="' + esc(T('Share')) + '">⇪</button>' : '') +
      '<button class="save" data-i="' + i + '">' + esc(T('Save')) + '</button></div></div>';
  }).join('') + (R.length > 1 ? '<button class="save saveall" id="saveall">' + esc(T('Save all as ZIP')) + '</button>' : '');
  box.querySelectorAll('.save[data-i]').forEach(b => b.onclick = () => { const r = R[+b.dataset.i]; saveBlob(r.name, r.blob); });
  box.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => preview(R[+b.dataset.pv]));
  box.querySelectorAll('[data-sh]').forEach(b => b.onclick = () => shareFile(R[+b.dataset.sh]));
  const sa = $('#saveall');
  if (sa) sa.onclick = async () => {
    sa.disabled = true; sa.textContent = T('Preparing ZIP…');
    try {
      await load('jszip'); const z = new JSZip(); const used = {};
      for (const r of R) { let n = r.name; if (used[n]) n = base(n) + '-' + (++used[r.name]) + '.' + n.split('.').pop(); else used[n] = 1; z.file(n, r.blob); }
      await saveBlob(state.tool.id + '-files.zip', await z.generateAsync({ type: 'blob' }));
    } catch (e) { toast(e.message || 'Could not make ZIP'); }
    finally { sa.disabled = false; sa.textContent = T('Save all as ZIP'); }
  };
}

/* Modal used by Preview and the Scan corner editor */
function openModal(title, bodyHtml, footHtml) {
  closeModal();
  const m = document.createElement('div'); m.className = 'modal'; m.id = 'modal';
  m.innerHTML = '<div class="mbox" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="mhead"><b>' + esc(title) + '</b><button class="ib" id="mclose" aria-label="Close">✕</button></div><div class="mbody" id="mbody">' + bodyHtml + '</div>' + (footHtml ? '<div class="mfoot">' + footHtml + '</div>' : '') + '</div>';
  document.body.appendChild(m); document.body.classList.add('noscroll');
  $('#mclose').onclick = closeModal;
  m.onclick = e => { if (e.target === m) closeModal(); };
  return m;
}
function closeModal() { const m = $('#modal'); if (m) { if (m._onclose) m._onclose(); m.remove(); } document.body.classList.remove('noscroll'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

let pvToken = 0;
async function preview(r) {
  const my = ++pvToken;
  const ext = r.name.split('.').pop().toLowerCase();
  const m = openModal(r.name, '<p class="mute center">' + esc(T('Loading preview…')) + '</p>');
  m._onclose = () => { pvToken++; };
  const body = $('#mbody');
  try {
    if (/^(jpg|png|webp)$/.test(ext)) { r.url = r.url || URL.createObjectURL(r.blob); body.innerHTML = '<img class="pvimg" src="' + r.url + '" alt="">'; }
    else if (ext === 'txt') { body.innerHTML = '<pre class="pvtxt">' + esc((await r.blob.text()).slice(0, 200000)) + '</pre>'; }
    else if (ext === 'docx') {
      await load('mammoth');
      const html = (await mammoth.convertToHtml({ arrayBuffer: await r.blob.arrayBuffer() })).value;
      if (my !== pvToken) return;
      body.innerHTML = '<div class="pvdoc doccontent">' + (html || '<p>(' + esc(T('empty')) + ')</p>') + '</div>';
    } else if (ext === 'pdf') {
      await load('pdfjs');
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await r.blob.arrayBuffer()) }).promise;
      if (my !== pvToken) return;
      const N = doc.numPages, max = Math.min(N, 30);
      body.innerHTML = '<p class="mute center">' + N + ' ' + esc(T('pages')) + (N > max ? ' · ' + esc(T('showing first')) + ' ' + max : '') + '</p>';
      const width = Math.min(900, body.clientWidth - 24) * Math.min(2, window.devicePixelRatio || 1);
      for (let i = 1; i <= max; i++) {
        if (my !== pvToken) { closePdf(doc); return; }
        const page = await doc.getPage(i); const v1 = page.getViewport({ scale: 1 });
        const c = await renderPdfPage(doc, i, width / v1.width);
        c.className = 'pvpage'; body.appendChild(c);
      }
      closePdf(doc);
    }
  } catch (e) { if (my === pvToken) body.innerHTML = '<p class="center">⚠️ ' + esc(T('Preview is not available for this file, but you can still save it.')) + '</p>'; }
}

function route(langChange) {
  const id = location.hash.replace(/^#/, '');
  const t = TOOLS.find(x => x.id === id) || (!id && PAGE_TOOL ? TOOLS.find(x => x.id === PAGE_TOOL) : null);
  if (t) {
    const keep = langChange === true && state.tool === t;
    if (!keep) state.busy = false;
    renderTool(t, keep);
    if (keep && state.results.length) showResults();
  } else { state.busy = false; renderHome(); if (langChange !== true) window.scrollTo(0, 0); }
}
window.addEventListener('hashchange', () => { closeModal(); route(false); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (!state.tool) renderHeader(null); });
document.documentElement.lang = LANG;
route(false);

/* Installable app + offline (only on a normal website such as GitHub Pages) */
if (!inClaude && 'serviceWorker' in navigator && location.protocol === 'https:') {
  try {
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // A newer version was just installed: reload once to show it (not on first install, not mid-task)
      if (hadController && !reloaded && !state.busy) { reloaded = true; location.reload(); }
    });
    navigator.serviceWorker.register(BASE + 'sw.js', { scope: BASE || './', updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  } catch (e) {}
}
