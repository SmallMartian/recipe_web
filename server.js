const http = require('http');
const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const basilAppConfigPath = path.join(rootDir, '..', 'Inventar_app', 'app.json');
const port = Number(process.env.PORT || 5174);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function writeEnvScript(res) {
  const basilSupabase = readBasilSupabaseConfig();
  const supabaseUrl = JSON.stringify(process.env.SUPABASE_URL || basilSupabase.supabaseUrl || '');
  const supabaseAnonKey = JSON.stringify(process.env.SUPABASE_ANON_KEY || basilSupabase.supabaseAnonKey || '');

  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  res.end(
    `window.RECIPE_WEB_SUPABASE_URL = ${supabaseUrl};\n` +
      `window.RECIPE_WEB_SUPABASE_ANON_KEY = ${supabaseAnonKey};\n`,
  );
}

function readBasilSupabaseConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(basilAppConfigPath, 'utf8'));
    const extra = config?.expo?.extra || {};

    return {
      supabaseUrl: extra.supabaseUrl || '',
      supabaseAnonKey: extra.supabaseAnonKey || '',
    };
  } catch {
    return {
      supabaseUrl: '',
      supabaseAnonKey: '',
    };
  }
}

function resolveRequestPath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = cleanPath === '/' ? '/index.html' : cleanPath;
  const requestedPath = path.join(rootDir, relativePath);

  if (!requestedPath.startsWith(rootDir)) {
    return null;
  }

  if (fs.existsSync(requestedPath) && fs.statSync(requestedPath).isDirectory()) {
    return path.join(requestedPath, 'index.html');
  }

  return requestedPath;
}

const server = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === '/assets/env.js') {
    writeEnvScript(res);
    return;
  }

  const filePath = resolveRequestPath(req.url || '/');

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(port, () => {
  console.log(`Recipe web running at http://localhost:${port}/`);
});
