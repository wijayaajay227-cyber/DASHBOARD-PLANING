'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const dataDirectory = path.join(root, 'server-data');
const usersPath = path.join(dataDirectory, 'users.json');
const statePath = path.join(dataDirectory, 'dashboard.json');
const dashboardCandidates = ['Dashboard Planning.html', 'Dashboard_Planning.html', 'dashboard.html'];
function resolveDashboardPath() {
  for (const name of dashboardCandidates) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Dashboard HTML file not found. Expected one of: ${dashboardCandidates.join(', ')}`);
}
const dashboardPath = resolveDashboardPath();
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const sessionLifetimeSeconds = 8 * 60 * 60;
const sessions = new Map();
const registrationRequired = Boolean(process.env.REGISTRATION_CODE);

fs.mkdirSync(dataDirectory, { recursive: true });

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

let users = readJson(usersPath, []);
let dashboardState = readJson(statePath, {
  items: [],
  stockItems: [],
  revision: 0,
  legacyImported: false
});

function jsonResponse(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(JSON.stringify(value));
}

function readRequestBody(request, maximumBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readJsonBody(request) {
  const raw = await readRequestBody(request);
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON request.'), { statusCode: 400 });
  }
}

function getSession(request) {
  const cookie = request.headers.cookie || '';
  const sessionCookie = cookie.split(';').map(value => value.trim())
    .find(value => value.startsWith('planning_session='));
  if (!sessionCookie) return null;

  const token = decodeURIComponent(sessionCookie.slice('planning_session='.length));
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetimeSeconds * 1000;
  return { token, session };
}

function isSecureRequest(request) {
  if (request.socket.encrypted) return true;
  const proto = request.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

function setSessionCookie(response, token, secure) {
  response.setHeader('Set-Cookie',
    `planning_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeSeconds}${secure ? '; Secure' : ''}`);
}

function isLoopback(request) {
  const address = request.socket.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function allowLegacyImportCors(request, response) {
  const origin = request.headers.origin;
  if (origin && origin !== 'null') return false;
  if (origin === 'null') response.setHeader('Access-Control-Allow-Origin', 'null');
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Vary', 'Origin');
  return true;
}

function replaceEmbeddedArray(html, variableName) {
  const marker = `let ${variableName} = /*STATE${variableName === 'items' ? '' : '2'}*/`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${variableName} state marker.`);
  const start = html.indexOf('[', markerIndex + marker.length);
  if (start < 0) throw new Error(`Could not find ${variableName} JSON array.`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth++;
    else if (character === ']' && --depth === 0) {
      JSON.parse(html.slice(start, index + 1));
      return html.slice(0, start) + '[]' + html.slice(index + 1);
    }
  }
  throw new Error(`Unclosed ${variableName} JSON array.`);
}

function emptyDivContents(html, id, content) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openingTag = new RegExp(`<div\\b(?=[^>]*\\bid=["']${escapedId}["'])[^>]*>`, 'i');
  const opening = openingTag.exec(html);
  if (!opening) throw new Error(`Could not find ${id} container.`);
  const openingIndex = opening.index;
  const contentStart = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = openingIndex;
  let depth = 0;
  let match;
  while ((match = tags.exec(html))) {
    if (match[0][1] === '/') depth--;
    else depth++;
    if (depth === 0) {
      return html.slice(0, contentStart) + content + html.slice(match.index);
    }
  }
  throw new Error(`Unclosed ${id} container.`);
}

function privateDashboardHtml() {
  let html = fs.readFileSync(dashboardPath, 'utf8');
  html = replaceEmbeddedArray(html, 'items');
  html = replaceEmbeddedArray(html, 'stockItems');
  html = emptyDivContents(html, 'list', '<div class="empty">Masuk untuk memuat data Jobshop.</div>');
  html = emptyDivContents(html, 'stockList', '<div class="empty">Masuk untuk memuat data Stock.</div>');
  html = emptyDivContents(html, 'problemList', '<div class="empty">Masuk untuk memuat data Problem.</div>');
  html = emptyDivContents(html, 'summary', '');
  html = emptyDivContents(html, 'stockSummary', '');
  return html;
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;

  if (pathname === '/api/legacy-import') {
    if (!allowLegacyImportCors(request, response)) {
      return jsonResponse(response, 403, { error: 'Legacy import is only allowed from this PC.' });
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== 'POST' || !isLoopback(request) || users.length > 0 || dashboardState.legacyImported) {
      return jsonResponse(response, 403, { error: 'Legacy import is closed.' });
    }
    const legacy = await readJsonBody(request);
    if (!Array.isArray(legacy.items) || !Array.isArray(legacy.stockItems)) {
      return jsonResponse(response, 400, { error: 'Invalid legacy dashboard data.' });
    }
    dashboardState = {
      items: legacy.items,
      stockItems: legacy.stockItems,
      revision: dashboardState.revision + 1,
      legacyImported: true
    };
    writeJson(statePath, dashboardState);
    return jsonResponse(response, 200, {
      ok: true,
      items: dashboardState.items.length,
      stockItems: dashboardState.stockItems.length
    });
  }

  if (request.method === 'POST' && pathname === '/api/register') {
    const body = await readJsonBody(request, 16 * 1024);
    const nik = String(body.nik || '').trim();
    const password = String(body.password || '');
    const registrationCode = String(body.registrationCode || '');
    if (registrationRequired && registrationCode !== process.env.REGISTRATION_CODE) {
      return jsonResponse(response, 403, { error: 'Kode undangan pendaftaran salah atau kosong.' });
    }
    if (!/^\d{4,32}$/.test(nik)) {
      return jsonResponse(response, 400, { error: 'NIK harus berisi 4-32 angka.' });
    }
    if (password.length < 8 || password.length > 256) {
      return jsonResponse(response, 400, { error: 'Password harus berisi 8-256 karakter.' });
    }
    if (users.some(user => user.nik === nik)) {
      return jsonResponse(response, 409, { error: 'NIK sudah terdaftar.' });
    }
    const salt = crypto.randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    const user = { nik, salt: salt.toString('base64url'), passwordHash: passwordHash.toString('base64url') };
    users.push(user);
    writeJson(usersPath, users);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { nik, expiresAt: Date.now() + sessionLifetimeSeconds * 1000 });
    setSessionCookie(response, token, isSecureRequest(request));
    return jsonResponse(response, 201, { ok: true, user: { nik } });
  }

  if (request.method === 'POST' && pathname === '/api/login') {
    const body = await readJsonBody(request, 16 * 1024);
    const nik = String(body.nik || '').trim();
    const password = String(body.password || '');
    const user = users.find(candidate => candidate.nik === nik);
    if (!user) return jsonResponse(response, 401, { error: 'NIK atau password salah.' });
    const derived = await scrypt(password, Buffer.from(user.salt, 'base64url'), 64);
    const expected = Buffer.from(user.passwordHash, 'base64url');
    if (derived.length !== expected.length || !crypto.timingSafeEqual(derived, expected)) {
      return jsonResponse(response, 401, { error: 'NIK atau password salah.' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { nik, expiresAt: Date.now() + sessionLifetimeSeconds * 1000 });
    setSessionCookie(response, token, isSecureRequest(request));
    return jsonResponse(response, 200, { ok: true, user: { nik } });
  }

  const activeSession = getSession(request);
  if (request.method === 'GET' && pathname === '/api/session') {
    return jsonResponse(response, 200, {
      authenticated: Boolean(activeSession),
      user: activeSession ? { nik: activeSession.session.nik } : null
    });
  }

  if (request.method === 'POST' && pathname === '/api/logout') {
    if (activeSession) sessions.delete(activeSession.token);
    response.setHeader('Set-Cookie', 'planning_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return jsonResponse(response, 200, { ok: true });
  }

  if (!activeSession) return jsonResponse(response, 401, { error: 'Silakan login kembali.' });

  if (request.method === 'GET' && pathname === '/api/state') {
    return jsonResponse(response, 200, dashboardState);
  }

  if (request.method === 'PUT' && pathname === '/api/state') {
    const body = await readJsonBody(request);
    if (!Array.isArray(body.items) || !Array.isArray(body.stockItems)) {
      return jsonResponse(response, 400, { error: 'Format data dashboard tidak valid.' });
    }
    dashboardState = {
      items: body.items,
      stockItems: body.stockItems,
      revision: dashboardState.revision + 1,
      legacyImported: dashboardState.legacyImported
    };
    writeJson(statePath, dashboardState);
    return jsonResponse(response, 200, { ok: true, revision: dashboardState.revision });
  }

  return jsonResponse(response, 404, { error: 'API route not found.' });
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = privateDashboardHtml();
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(html);
    }
    return jsonResponse(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error('request failed:', error.message);
    if (!response.headersSent) jsonResponse(response, error.statusCode || 500, { error: 'Request failed.' });
    else response.destroy();
  }
});

server.listen(port, host, () => {
  console.log(`Planning dashboard server listening on http://localhost:${port}`);
  console.log('Team devices can connect to this PC IPv4 address on the same network.');
});