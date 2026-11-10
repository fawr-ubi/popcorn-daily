#!/usr/bin/env node

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_DIR = path.resolve(__dirname, '..');
const ENGINE_SCRIPT = path.join(SKILL_DIR, 'scripts', 'daily-engine.js');
const PACKAGE_SCRIPT = path.join(SKILL_DIR, 'scripts', 'package-zip.sh');

if (!process.env.PATH?.includes('/opt/homebrew/bin')) {
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`;
}

const CONFIG_DIR = path.join(process.env.HOME, '.config', 'popcorn-daily');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const ACLI_CONFIG_PATH = path.join(process.env.HOME, '.config', 'acli', 'jira_config.yaml');
const SNAPSHOTS_DIR = path.join(CONFIG_DIR, 'snapshots');
const REPORTS_DIR = path.join(CONFIG_DIR, 'reports');

const PORT = parseInt(process.env.PORT || '4343', 10);

function getTodayParisDate() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function readUserConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveUserConfig(partial) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = readUserConfig();
  const next = {
    ...existing,
    ...partial,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function listAvailableDates() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) return [];
  return fs
    .readdirSync(SNAPSHOTS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort()
    .reverse();
}

function readSnapshot(dateStr) {
  const file = path.join(SNAPSHOTS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function runEngineRefresh(sinceDays = 1) {
  const args = [ENGINE_SCRIPT, 'json', '--since-days', String(sinceDays)];
  const { stdout } = await execFileAsync('node', args, {
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/api/state') {
      let dates = listAvailableDates();
      const requestedDate = urlObj.searchParams.get('date');
      const todayStr = getTodayParisDate();

      // If no specific historical date was requested and today's snapshot does not exist yet,
      // automatically run a fresh sync for today!
      const shouldAutoRefreshToday = !requestedDate && (!dates.length || dates[0] !== todayStr);
      let targetDate = requestedDate || dates[0];
      let snapshot = targetDate ? readSnapshot(targetDate) : null;

      if (shouldAutoRefreshToday || !snapshot || !Array.isArray(snapshot.members)) {
        try {
          snapshot = await runEngineRefresh(1);
          dates = listAvailableDates();
          targetDate = snapshot.targetDateStr;
        } catch (err) {
          const errMsg = err.stderr || err.message || '';
          if (errMsg.includes('AUTH_REQUIRED') || !snapshot) {
            return sendJson(res, 200, {
              dates,
              currentDate: targetDate || null,
              snapshot: snapshot || null,
              needsSetup: true,
              authError: errMsg.replace(/^[\s\S]*?AUTH_REQUIRED:\s*/, '').trim() || 'Configuration Jira requise',
            });
          }
        }
      }

      return sendJson(res, 200, {
        dates,
        currentDate: targetDate,
        snapshot,
        needsSetup: false,
      });
    }

    if (req.method === 'GET' && pathname === '/api/config') {
      const cfg = readUserConfig();
      const hasAcli = fs.existsSync(ACLI_CONFIG_PATH);
      return sendJson(res, 200, {
        email: cfg.email || '',
        hasJiraToken: Boolean(cfg.jiraApiToken),
        hasGithubToken: Boolean(cfg.githubToken),
        hasAcli,
      });
    }

    if (req.method === 'POST' && pathname === '/api/config') {
      const body = await readBodyJson(req);
      const updates = {};
      if (typeof body.email === 'string' && body.email.trim()) {
        updates.email = body.email.trim();
      }
      if (typeof body.jiraApiToken === 'string' && body.jiraApiToken.trim()) {
        updates.jiraApiToken = body.jiraApiToken.trim();
      }
      if (typeof body.githubToken === 'string' && body.githubToken.trim()) {
        updates.githubToken = body.githubToken.trim();
      }
      saveUserConfig(updates);

      try {
        const snapshot = await runEngineRefresh(1);
        const dates = listAvailableDates();
        return sendJson(res, 200, {
          ok: true,
          dates,
          currentDate: snapshot.targetDateStr,
          snapshot,
        });
      } catch (err) {
        const errMsg = (err.stderr || err.message || '').replace(/^[\s\S]*?Error in popcorn-daily engine:\s*/, '').trim();
        return sendJson(res, 400, {
          error: errMsg || 'Impossible de se connecter à Jira avec ces identifiants.',
        });
      }
    }

    if (req.method === 'POST' && pathname === '/api/refresh') {
      const body = await readBodyJson(req);
      const sinceDays = parseInt(body.sinceDays || '1', 10) || 1;
      try {
        const snapshot = await runEngineRefresh(sinceDays);
        const dates = listAvailableDates();
        return sendJson(res, 200, {
          ok: true,
          dates,
          currentDate: snapshot.targetDateStr,
          snapshot,
        });
      } catch (err) {
        const errMsg = (err.stderr || err.message || '').replace(/^[\s\S]*?Error in popcorn-daily engine:\s*/, '').trim();
        return sendJson(res, 400, {
          error: errMsg || 'Échec de la synchronisation Jira/GitHub',
          needsSetup: errMsg.includes('AUTH_REQUIRED'),
        });
      }
    }

    if (req.method === 'POST' && pathname === '/api/transition') {
      const body = await readBodyJson(req);
      const { key, targetStatus, date } = body;
      if (!key || !targetStatus) {
        return sendJson(res, 400, { error: 'Missing key or targetStatus' });
      }

      const { stdout } = await execFileAsync('node', [ENGINE_SCRIPT, 'transition', key, targetStatus], {
        timeout: 25000,
      });

      // Update cached snapshot optimistically so the UI updates instantaneously
      const dates = listAvailableDates();
      const snapDate = date || dates[0];
      const snapFile = path.join(SNAPSHOTS_DIR, `${snapDate}.json`);
      if (snapDate && fs.existsSync(snapFile)) {
        const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
        snap.prAlerts = (snap.prAlerts || []).filter((a) => a.key !== key);
        snap.unblockAlerts = (snap.unblockAlerts || []).map((u) =>
          u.targetKey === key ? { ...u, targetStatus, suggestedStatus: null } : u
        );
        for (const m of snap.members || []) {
          for (const act of m.active || []) {
            if (act.key === key) act.status = targetStatus;
          }
        }
        for (const g of snap.storyGroups || []) {
          if (g.story.key === key) g.story.status = targetStatus;
          for (const c of g.children || []) {
            if (c.key === key) c.status = targetStatus;
          }
        }
        fs.writeFileSync(snapFile, JSON.stringify(snap, null, 2), 'utf8');
      }

      return sendJson(res, 200, {
        ok: true,
        key,
        targetStatus,
        message: stdout.trim(),
      });
    }

    if (req.method === 'GET' && pathname === '/api/markdown') {
      const dates = listAvailableDates();
      const date = urlObj.searchParams.get('date') || dates[0];
      const mdPath = path.join(REPORTS_DIR, `${date}.md`);
      const content = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : '';
      return sendJson(res, 200, { date, content });
    }

    if (req.method === 'GET' && pathname === '/api/export-zip') {
      await execFileAsync('bash', [PACKAGE_SCRIPT], { timeout: 20000 });
      const zipPath = path.join(process.env.HOME, '.gemini', 'config', 'skills', 'popcorn-daily.zip');
      if (!fs.existsSync(zipPath)) {
        return sendJson(res, 404, { error: 'Zip archive not found' });
      }
      const stat = fs.statSync(zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="popcorn-daily.zip"',
      });
      fs.createReadStream(zipPath).pipe(res);
      return;
    }

    // Static files
    const staticMap = {
      '/': { file: 'index.html', mime: 'text/html; charset=utf-8' },
      '/index.html': { file: 'index.html', mime: 'text/html; charset=utf-8' },
      '/styles.css': { file: 'styles.css', mime: 'text/css; charset=utf-8' },
      '/app.js': { file: 'app.js', mime: 'application/javascript; charset=utf-8' },
    };

    if (req.method === 'GET' && staticMap[pathname]) {
      const target = staticMap[pathname];
      const fullPath = path.join(__dirname, target.file);
      res.writeHead(200, {
        'Content-Type': target.mime,
        'Cache-Control': 'no-cache',
      });
      res.end(fs.readFileSync(fullPath));
      return;
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`🍿 Popcorn Daily Hub running on http://localhost:${PORT}`);
});
