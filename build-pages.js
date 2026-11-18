// Generates one SEO page per tool (e.g. /compress-pdf/) from index.html. Run: node build-pages.js
const fs = require('fs');
const SITE = 'https://drkaushik-dnb.github.io/pdfconvertfree/';
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');
const tools = [...src.matchAll(/\{ id: '([a-z0-9-]+)', [^\n]*?title: '([^']+)', desc: '([^']+)', seo: '([^']+)'/g)].map(m => ({ id: m[1], title: m[2], desc: m[3], seo: m[4] }));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
let index = fs.readFileSync(__dirname + '/index.html', 'utf8');
// root page canonical
if (!index.includes('rel="canonical"')) index = index.replace('<meta name="theme-color"', '<link rel="canonical" href="' + SITE + '">\n<meta name="theme-color"');
fs.writeFileSync(__dirname + '/index.html', index);
for (const t of tools) {
  const title = t.seo + ' – Free & Private | PDF Convert Free';
  const desc = t.desc + ' Free, no upload – works in your browser. Files never leave your device.';
  let h = index
    .replace(/<title>[^<]*<\/title>/, '<title>' + esc(title) + '</title>')
    .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="' + esc(desc) + '">')
    .replace(/<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="' + SITE + t.id + '/">')
    .replace(/href="(manifest\.json|[\w-]+\.png)"/g, 'href="../$1"')
    .replace('<script src="i18n.js"></script>', '<script src="../i18n.js"></script>').replace('<script src="app.js"></script>', '<script src="../app.js"></script>')
    .replace('<body data-base="">', '<body data-base="../" data-tool="' + t.id + '">')
    .replace('<main id="main"></main>', '<main id="main"><h1>' + esc(t.seo) + '</h1><p>' + esc(desc) + '</p></main>');
  fs.mkdirSync(__dirname + '/' + t.id, { recursive: true });
  fs.writeFileSync(__dirname + '/' + t.id + '/index.html', h);
}
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(__dirname + '/sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  ['', ...tools.map(t => t.id + '/')].map(p => '  <url><loc>' + SITE + p + '</loc><lastmod>' + today + '</lastmod></url>').join('\n') + '\n</urlset>\n');
fs.writeFileSync(__dirname + '/robots.txt', 'User-agent: *\nAllow: /\nSitemap: ' + SITE + 'sitemap.xml\n');
console.log(tools.length + ' tool pages built');
