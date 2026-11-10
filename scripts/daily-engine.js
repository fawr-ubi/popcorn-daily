#!/usr/bin/env node

/**
 * Popcorn Daily Scrum Assistant Engine (daily-engine.js)
 *
 * Tracks daily Jira status transitions, workday stagnation, dependency hand-offs
 * (BACK -> FRONT, Story -> Waiting for QA, Blocks, Relates), and GitHub PR <-> Jira
 * status drift for the Popcorn engineering team.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync, execFileSync } = require('child_process');

// Ensure Homebrew binaries are always found even when launched via macOS Finder .command
if (!process.env.PATH?.includes('/opt/homebrew/bin')) {
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || '/usr/bin:/bin'}`;
}

const SKILL_DIR = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(SKILL_DIR, 'VERSION');
const VERSION = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : '1.0.0';

const CONFIG_DIR = path.join(process.env.HOME, '.config', 'popcorn-daily');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const REPORTS_DIR = path.join(CONFIG_DIR, 'reports');
const SNAPSHOTS_DIR = path.join(CONFIG_DIR, 'snapshots');
const ACLI_JIRA_CONFIG_PATH = path.join(process.env.HOME, '.config', 'acli', 'jira_config.yaml');

const logProgress = (msg) => process.stderr.write(`⏳ ${msg}\n`);

const DEFAULT_CONFIG = {
  accountId: '',
  cloudId: 'd63002be-9c5b-4a32-a91a-95c68aa5dc73',
  email: '',
  jiraApiToken: '',
  githubToken: '',
  displayName: '',
  githubUser: '',
  teamId: 'b6f87d61-69e0-459b-ba68-a322281b9805',
  teamName: 'Popcorn',
  boardId: 1314,
  githubOrg: 'ubitransports',
  jiraBaseUrl: 'https://ubitransport.atlassian.net/browse/',
  staleThresholdsWorkdays: {
    IN_PROGRESS: 3,
    IN_REVIEW: 2,
    IN_QA: 2,
  },
  prStaleReviewHours: 24,
  frenchHolidays2026: [
    '2026-01-01',
    '2026-04-06',
    '2026-05-01',
    '2026-05-08',
    '2026-05-14',
    '2026-05-25',
    '2026-07-14',
    '2026-08-15',
    '2026-11-01',
    '2026-11-11',
    '2026-12-25',
  ],
};

function autoDetectIdentity() {
  const detected = {};
  if (fs.existsSync(ACLI_JIRA_CONFIG_PATH)) {
    const yaml = fs.readFileSync(ACLI_JIRA_CONFIG_PATH, 'utf8');
    const cloudMatch = yaml.match(/cloud_id:\s*([^\s\n]+)/);
    const accountMatch = yaml.match(/account_id:\s*([^\s\n]+)/);
    const emailMatch = yaml.match(/email:\s*([^\s\n]+)/);
    const nameMatch = yaml.match(/display_name:\s*(.+)/);
    if (cloudMatch) detected.cloudId = cloudMatch[1].trim();
    if (accountMatch) detected.accountId = accountMatch[1].trim();
    if (emailMatch) detected.email = emailMatch[1].trim();
    if (nameMatch) detected.displayName = nameMatch[1].trim();
  }
  try {
    const ghLogin = execSync('gh api user --jq .login', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (ghLogin) detected.githubUser = ghLogin;
  } catch (e) {}
  return detected;
}

function loadConfig() {
  const detected = autoDetectIdentity();
  let userCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {}
  }
  return {
    ...DEFAULT_CONFIG,
    ...detected,
    ...userCfg,
    staleThresholdsWorkdays: {
      ...DEFAULT_CONFIG.staleThresholdsWorkdays,
      ...(userCfg.staleThresholdsWorkdays || {}),
    },
  };
}

function refreshAcliToken() {
  logProgress('      Refreshing expired acli OAuth token...');
  try {
    execSync('acli jira workitem view PRD-17449 --json --fields summary', {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch (e) {}
}

function getJiraToken(cfg) {
  if (cfg.jiraApiToken && cfg.email) {
    return {
      type: 'basic',
      header: `Basic ${Buffer.from(`${cfg.email.trim()}:${cfg.jiraApiToken.trim()}`).toString('base64')}`,
    };
  }
  if (!cfg.accountId) {
    throw new Error('AUTH_REQUIRED: Aucun accès Jira configuré. Clique sur "⚙️ Accès" en haut à droite pour configurer ton accès en 1 minute.');
  }
  logProgress('[1/4] Reading Jira OAuth token from macOS Keychain...');
  const acct = `jira:${cfg.cloudId}:${cfg.accountId}`;
  const readKeychain = () => {
    const raw = execSync(`security find-generic-password -s acli -a "${acct}" -w`, {
      encoding: 'utf8',
      timeout: 30000,
    })
      .trim()
      .replace(/^go-keyring-base64:/, '');
    return JSON.parse(zlib.gunzipSync(Buffer.from(raw, 'base64')).toString());
  };

  let json;
  try {
    json = readKeychain();
  } catch (err) {
    throw new Error('AUTH_REQUIRED: Impossible de lire le trousseau Jira. Clique sur "⚙️ Accès" en haut à droite pour configurer ton Token Jira.');
  }
  if (json.expiry && new Date(json.expiry).getTime() - Date.now() < 10 * 60 * 1000) {
    refreshAcliToken();
    json = readKeychain();
  }
  return { type: 'bearer', header: `Bearer ${json.access_token}`, readKeychain };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes bilingual (FR / EN) Jira status names into 5 semantic groups:
 * READY, IN_PROGRESS, IN_REVIEW, IN_QA, DONE
 */
function classifyStatus(statusName = '', statusCategoryKey = '') {
  const s = statusName.trim().toLowerCase();

  if (
    /termin|done|closed|resolved|ferm|résolu/i.test(s) ||
    statusCategoryKey === 'done'
  ) {
    return 'DONE';
  }
  if (/qa|recette|test|validation/i.test(s)) {
    return 'IN_QA';
  }
  if (/revue|review|waiting merge|merge|pr /i.test(s)) {
    return 'IN_REVIEW';
  }
  if (/en cours|in progress|progress|développement/i.test(s)) {
    return 'IN_PROGRESS';
  }
  if (
    /à faire|to do|todo|ready|open|nouveau|new|support level|brouillon|draft|backlog/i.test(s) ||
    statusCategoryKey === 'new'
  ) {
    return 'READY';
  }
  return 'IN_PROGRESS';
}

function isMergeWaitingStatus(statusName = '') {
  return /waiting merge/i.test(statusName.trim());
}

/**
 * Canonical workflow status sort rank ("Walk the Board" right-to-left:
 * closest to completion first, then active dev, then ready, then done).
 */
function getStatusOrderRank(statusName = '', statusGroup = '') {
  const s = statusName.trim().toLowerCase();
  if (/in qa/i.test(s)) return 10;
  if (/waiting for qa|ready for qa/i.test(s) || statusGroup === 'IN_QA') return 15;
  if (/waiting merge/i.test(s)) return 20;
  if (/revue|review/i.test(s) || statusGroup === 'IN_REVIEW') return 25;
  if (/en cours|in progress/i.test(s) || statusGroup === 'IN_PROGRESS') return 30;
  if (statusGroup === 'READY') return 40;
  if (statusGroup === 'DONE') return 50;
  return 35;
}

/**
 * Detects technical role (BACK, FRONT, QA, 2CLOUD, STORY) from issue summary and type.
 */
function detectIssueRole(issue) {
  const key = issue.key || '';
  const summary = issue.summary || '';
  const type = issue.type || '';

  if (/^QA-/i.test(key) || /test/i.test(type)) return 'QA';
  if (/story|récit|epic/i.test(type)) return 'STORY';
  if (/\bFRONT(END)?\b/i.test(summary)) return 'FRONT';
  if (/\bBACK(END)?\b/i.test(summary)) return 'BACK';
  if (/2cloud|☁️/i.test(summary)) return '2CLOUD';
  return 'TASK';
}

function isWorkday(dateStr, holidays = []) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (holidays.includes(dateStr)) return false;
  return true;
}

function toParisDateString(dateInput) {
  const d = typeof dateInput === 'string' || typeof dateInput === 'number' ? new Date(dateInput) : dateInput;
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Counts workdays elapsed between startIso and targetDateStr (excluding start day itself).
 */
function countWorkdaysBetween(startIso, targetDateStr, holidays = []) {
  if (!startIso) return 0;
  const startDateStr = toParisDateString(startIso);
  if (startDateStr >= targetDateStr) return 0;

  let count = 0;
  const curr = new Date(`${startDateStr}T12:00:00Z`);
  const end = new Date(`${targetDateStr}T12:00:00Z`);
  curr.setUTCDate(curr.getUTCDate() + 1);

  while (curr <= end) {
    const ds = curr.toISOString().slice(0, 10);
    if (isWorkday(ds, holidays)) {
      count++;
    }
    curr.setUTCDate(curr.getUTCDate() + 1);
  }
  return count;
}

/**
 * Computes the timestamp of the previous workday morning (08:30 Europe/Paris)
 * so Monday morning automatically captures Friday's and weekend's changes.
 */
function getPreviousWorkdayCutoff(targetDateStr, sinceWorkdays = 1, holidays = []) {
  const curr = new Date(`${targetDateStr}T12:00:00Z`);
  let remaining = sinceWorkdays;
  while (remaining > 0) {
    curr.setUTCDate(curr.getUTCDate() - 1);
    const ds = curr.toISOString().slice(0, 10);
    if (isWorkday(ds, holidays)) {
      remaining--;
    }
  }
  const cutoffDateStr = curr.toISOString().slice(0, 10);
  return {
    cutoffDateStr,
    cutoffIso: `${cutoffDateStr}T00:00:00.000Z`,
  };
}

/**
 * Extracts chronological status transitions from Jira changelog.
 */
function parseStatusHistory(rawIssue) {
  const histories = rawIssue.changelog?.histories || [];
  const transitions = [];

  for (const h of histories) {
    for (const item of h.items || []) {
      if (item.field === 'status') {
        transitions.push({
          at: h.created,
          dateStr: toParisDateString(h.created),
          author: h.author?.displayName || 'System',
          from: item.fromString || '',
          to: item.toString || '',
          fromGroup: classifyStatus(item.fromString || ''),
          toGroup: classifyStatus(item.toString || ''),
        });
      }
    }
  }

  transitions.sort((a, b) => new Date(a.at) - new Date(b.at));
  return transitions;
}

/**
 * Fetches all sprint issues + resolves missing linked/parent issues in Jira.
 */
async function fetchSprintData(cfg, auth) {
  logProgress(`[2/4] Fetching active sprint issues for Team ${cfg.teamName} (${cfg.teamId})...`);
  const baseUrl =
    auth.type === 'basic'
      ? 'https://ubitransport.atlassian.net/rest/api/3'
      : `https://api.atlassian.com/ex/jira/${cfg.cloudId}/rest/api/3`;
  const headers = { Authorization: auth.header, 'Content-Type': 'application/json' };

  const jql = `"Team[Team]" = ${cfg.teamId} AND sprint in openSprints() ORDER BY key ASC`;
  const fields = [
    'summary',
    'status',
    'issuetype',
    'priority',
    'assignee',
    'parent',
    'subtasks',
    'issuelinks',
    'created',
    'updated',
    'customfield_10020',
  ];

  const allRawIssues = [];
  let nextPageToken = undefined;

  while (true) {
    const body = { jql, fields, expand: 'changelog', maxResults: 100 };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    let res = await fetchWithTimeout(`${baseUrl}/search/jql`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 401 && auth.type === 'bearer' && auth.readKeychain) {
      refreshAcliToken();
      const freshJson = auth.readKeychain();
      auth.header = `Bearer ${freshJson.access_token}`;
      headers.Authorization = auth.header;
      res = await fetchWithTimeout(`${baseUrl}/search/jql`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`AUTH_REQUIRED: Session ou Token Jira invalide (${res.status}). Vérifie tes identifiants dans "⚙️ Accès".`);
      }
      throw new Error(`Jira search failed (${res.status}): ${errText}`);
    }
    const data = await res.json();
    allRawIssues.push(...(data.issues || []));
    if (!data.nextPageToken || (data.issues || []).length === 0) break;
    nextPageToken = data.nextPageToken;
  }

  // Collect external linked keys (Parent-Child, Parent, Covering) not yet in allRawIssues
  const fetchedKeys = new Set(allRawIssues.map((i) => i.key));
  const missingLinkedKeys = new Set();

  for (const raw of allRawIssues) {
    const f = raw.fields || {};
    if (f.parent?.key && !fetchedKeys.has(f.parent.key) && f.parent.fields?.issuetype?.name !== 'Epic') {
      missingLinkedKeys.add(f.parent.key);
    }
    for (const l of f.issuelinks || []) {
      const tKey = (l.outwardIssue || l.inwardIssue)?.key;
      const tType = l.type?.name || '';
      if (tKey && !fetchedKeys.has(tKey) && ['Parent-Child', 'Parent', 'Covering'].includes(tType)) {
        missingLinkedKeys.add(tKey);
      }
    }
  }

  const externalIssueMap = new Map();
  if (missingLinkedKeys.size > 0) {
    const missingArr = [...missingLinkedKeys].slice(0, 80);
    try {
      const resExt = await fetchWithTimeout(`${baseUrl}/search/jql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jql: `key in (${missingArr.join(',')})`,
          fields: ['summary', 'status', 'issuetype', 'assignee'],
          maxResults: 100,
        }),
      });
      if (resExt.ok) {
        const dataExt = await resExt.json();
        for (const ext of dataExt.issues || []) {
          externalIssueMap.set(ext.key, {
            key: ext.key,
            summary: (ext.fields?.summary || '').trim(),
            type: ext.fields?.issuetype?.name || 'Task',
            status: ext.fields?.status?.name || 'Unknown',
            statusGroup: classifyStatus(
              ext.fields?.status?.name || '',
              ext.fields?.status?.statusCategory?.key || ''
            ),
            assignee: ext.fields?.assignee?.displayName || 'Non assigné',
          });
        }
      }
    } catch (e) {}
  }

  return { baseUrl, headers, rawIssues: allRawIssues, externalIssueMap };
}

/**
 * Normalizes raw Jira issues into structured objects.
 */
function normalizeIssues(rawIssues, targetDateStr, cutoffIso, cfg) {
  const issueMap = new Map();
  let activeSprintName = `${cfg.teamName} Active Sprint`;

  for (const raw of rawIssues) {
    const f = raw.fields || {};
    const statusName = f.status?.name || 'Unknown';
    const statusCategoryKey = f.status?.statusCategory?.key || '';
    const statusGroup = classifyStatus(statusName, statusCategoryKey);

    const activeSprints = (f.customfield_10020 || []).filter((s) => s.state === 'active');
    const teamSprint =
      activeSprints.find(
        (s) =>
          s.boardId === cfg.boardId ||
          (cfg.teamName && s.name?.toLowerCase().includes(cfg.teamName.toLowerCase()))
      ) || activeSprints[0];
    if (teamSprint?.name && (activeSprintName.endsWith('Active Sprint') || teamSprint.boardId === cfg.boardId)) {
      activeSprintName = teamSprint.name;
    }

    const transitions = parseStatusHistory(raw);
    const lastTransition = transitions.length > 0 ? transitions[transitions.length - 1] : null;
    const statusSinceIso = lastTransition ? lastTransition.at : f.created;
    const statusSinceDate = toParisDateString(statusSinceIso);
    const workdaysInStatus = countWorkdaysBetween(statusSinceIso, targetDateStr, cfg.frenchHolidays2026);

    const recentTransitions = transitions.filter((t) => new Date(t.at) >= new Date(cutoffIso));

    const links = (f.issuelinks || []).map((l) => {
      const isOutward = !!l.outwardIssue;
      const target = l.outwardIssue || l.inwardIssue;
      const tStatus = target?.fields?.status?.name || 'Unknown';
      const tCatKey = target?.fields?.status?.statusCategory?.key || '';
      return {
        typeName: l.type?.name || 'Link',
        direction: isOutward ? 'outward' : 'inward',
        relation: isOutward ? l.type?.outward : l.type?.inward,
        targetKey: target?.key,
        targetSummary: target?.fields?.summary || '',
        targetStatus: tStatus,
        targetStatusGroup: classifyStatus(tStatus, tCatKey),
        targetType: target?.fields?.issuetype?.name || '',
      };
    }).filter((l) => l.targetKey);

    const normalized = {
      key: raw.key,
      url: `${cfg.jiraBaseUrl}${raw.key}`,
      summary: (f.summary || '').trim(),
      type: f.issuetype?.name || 'Task',
      role: detectIssueRole({
        key: raw.key,
        summary: f.summary || '',
        type: f.issuetype?.name || '',
      }),
      status: statusName,
      statusGroup,
      assignee: f.assignee?.displayName || 'Unassigned',
      assigneeAccountId: f.assignee?.accountId || null,
      parent: f.parent
        ? {
            key: f.parent.key,
            summary: f.parent.fields?.summary || '',
            type: f.parent.fields?.issuetype?.name || '',
            status: f.parent.fields?.status?.name || '',
            statusGroup: classifyStatus(
              f.parent.fields?.status?.name || '',
              f.parent.fields?.status?.statusCategory?.key || ''
            ),
          }
        : null,
      created: f.created,
      updated: f.updated,
      statusSinceIso,
      statusSinceDate,
      workdaysInStatus,
      transitions,
      recentTransitions,
      links,
      prs: [],
    };

    issueMap.set(raw.key, normalized);
  }

  return { activeSprintName, issueMap };
}

/**
 * Queries GitHub Pull Requests in chunks of 5 Jira keys (respecting GitHub Search 5-OR limit).
 * Supports both a direct GitHub Personal Access Token (PO-friendly, zero CLI required)
 * and the `gh` CLI when installed.
 */
async function fetchGithubPrsForSprint(issueMap, cfg) {
  logProgress(`[3/4] Querying GitHub Pull Requests across org:${cfg.githubOrg}...`);
  const allKeys = [...issueMap.keys()];
  if (allKeys.length === 0) return;

  const chunks = [];
  for (let i = 0; i < allKeys.length; i += 5) {
    chunks.push(allKeys.slice(i, i + 5));
  }

  // Group into GraphQL batches of up to 8 aliases (40 keys per GraphQL call)
  const aliasBatches = [];
  for (let i = 0; i < chunks.length; i += 8) {
    aliasBatches.push(chunks.slice(i, i + 8));
  }

  const prFields = `nodes {
    ... on PullRequest {
      number
      title
      url
      state
      isDraft
      headRefName
      createdAt
      updatedAt
      mergedAt
      author { login }
      repository { name }
      reviewDecision
      latestReviews(first: 10) {
        nodes {
          author { login }
          state
          submittedAt
        }
      }
    }
  }`;

  const seenPrUrls = new Map();

  for (const batch of aliasBatches) {
    const aliases = batch
      .map((chunk, idx) => {
        const qStr = `org:${cfg.githubOrg} is:pr ${chunk.join(' OR ')}`;
        return `b${idx}: search(query: ${JSON.stringify(qStr)}, type: ISSUE, first: 40) { ${prFields} }`;
      })
      .join('\n');

    const graphqlQuery = `query {\n${aliases}\n}`;

    try {
      let parsed = {};
      if (cfg.githubToken && cfg.githubToken.trim()) {
        const ghRes = await fetchWithTimeout('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.githubToken.trim()}`,
            'Content-Type': 'application/json',
            'User-Agent': 'popcorn-daily-hub',
          },
          body: JSON.stringify({ query: graphqlQuery }),
        });
        if (ghRes.ok) {
          const json = await ghRes.json();
          parsed = json.data || {};
        }
      } else {
        const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${graphqlQuery}`], {
          encoding: 'utf8',
          timeout: 20000,
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        parsed = JSON.parse(out).data || {};
      }
      for (const aliasResult of Object.values(parsed)) {
        for (const pr of aliasResult?.nodes || []) {
          if (pr && pr.url) {
            seenPrUrls.set(pr.url, pr);
          }
        }
      }
    } catch (e) {
      logProgress(`      Warning: GitHub GraphQL batch failed (${e.message})`);
    }
  }

  // Match PRs strictly to issue keys found in title or branch name
  for (const pr of seenPrUrls.values()) {
    const haystack = `${pr.title || ''} ${pr.headRefName || ''}`;
    const matches = haystack.match(/\b[A-Z][A-Z0-9]+-[0-9]+\b/gi) || [];
    const matchedKeys = new Set(matches.map((m) => m.toUpperCase()));

    for (const key of matchedKeys) {
      const issue = issueMap.get(key);
      if (!issue) continue;
      // Ignore closed-unmerged PRs unless no other PR exists
      issue.prs.push({
        number: pr.number,
        repo: pr.repository?.name || 'repo',
        title: pr.title,
        url: pr.url,
        state: pr.state, // OPEN, MERGED, CLOSED
        isDraft: !!pr.isDraft,
        branch: pr.headRefName,
        author: pr.author?.login || 'unknown',
        reviewDecision: pr.reviewDecision || null, // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        mergedAt: pr.mergedAt,
        latestReviews: (pr.latestReviews?.nodes || []).filter(Boolean),
      });
    }
  }

  // Sort PRs per issue: OPEN first, then MERGED, then CLOSED
  const stateRank = { OPEN: 0, MERGED: 1, CLOSED: 2 };
  for (const issue of issueMap.values()) {
    issue.prs.sort((a, b) => (stateRank[a.state] ?? 3) - (stateRank[b.state] ?? 3));
  }
}

/**
 * Analyzes the sprint to extract:
 * 1. PR <-> Jira Sync Alerts (4 rules)
 * 2. Dependency Unblocks / Hand-offs (4 rules)
 * 3. Stale / Aging WIP Tickets (differentiated workday thresholds)
 * 4. Recent Transitions (since last daily)
 * 5. Story / Feature Hierarchy
 * 6. Team Member Summary
 */
function analyzeSprint(issueMap, externalIssueMap = new Map(), cfg) {
  logProgress('[4/4] Analyzing status transitions, dependency graph, and GitHub PR sync...');

  const prAlerts = [];
  const unblockAlerts = [];
  const staleAlerts = [];
  const recentMovements = [];

  // Build Story -> Children map (combining Parent-Child, Parent, Covering, and issue.parent)
  const storyChildrenMap = new Map();
  const childToStoriesMap = new Map();

  const registerParentChild = (storyKey, childKey, via, fallbackChildInfo = null) => {
    if (!storyKey || !childKey || storyKey === childKey) return;
    if (!storyChildrenMap.has(storyKey)) storyChildrenMap.set(storyKey, new Map());
    storyChildrenMap.get(storyKey).set(childKey, { via, fallbackChildInfo });

    if (!childToStoriesMap.has(childKey)) childToStoriesMap.set(childKey, new Set());
    childToStoriesMap.get(childKey).add(storyKey);
  };

  for (const issue of issueMap.values()) {
    if (issue.parent && issue.parent.type !== 'Epic' && issueMap.has(issue.parent.key)) {
      registerParentChild(issue.parent.key, issue.key, 'parent');
    }
    for (const link of issue.links) {
      const extInfo = externalIssueMap.get(link.targetKey);
      const linkChildObj = {
        key: link.targetKey,
        url: `${cfg.jiraBaseUrl}${link.targetKey}`,
        summary: extInfo?.summary || link.targetSummary,
        type: extInfo?.type || link.targetType || 'Task',
        role: detectIssueRole({
          key: link.targetKey,
          summary: extInfo?.summary || link.targetSummary,
          type: extInfo?.type || link.targetType || '',
        }),
        status: extInfo?.status || link.targetStatus,
        statusGroup: extInfo?.statusGroup || link.targetStatusGroup,
        assignee: extInfo?.assignee || 'Non assigné',
        workdaysInStatus: 0,
        recentTransitions: [],
        prs: [],
      };
      if (['Parent-Child', 'Parent'].includes(link.typeName)) {
        if (link.direction === 'outward') {
          registerParentChild(issue.key, link.targetKey, link.typeName, linkChildObj);
        } else {
          registerParentChild(link.targetKey, issue.key, link.typeName);
        }
      } else if (link.typeName === 'Covering') {
        if (link.direction === 'inward') {
          registerParentChild(issue.key, link.targetKey, 'Covering', linkChildObj);
        } else {
          registerParentChild(link.targetKey, issue.key, 'Covering');
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Recent Movements & 3. Stale Tickets & 1. PR <-> Jira Drift
  // ---------------------------------------------------------------------------
  for (const issue of issueMap.values()) {
    // Recent movements
    if (issue.recentTransitions.length > 0) {
      const firstT = issue.recentTransitions[0];
      const lastT = issue.recentTransitions[issue.recentTransitions.length - 1];
      recentMovements.push({
        issue,
        from: firstT.from,
        to: lastT.to,
        at: lastT.at,
        dateStr: lastT.dateStr,
        author: lastT.author,
        transitionsCount: issue.recentTransitions.length,
      });
    }

    // Stale check (exclude READY and DONE)
    if (!['READY', 'DONE'].includes(issue.statusGroup)) {
      const threshold = cfg.staleThresholdsWorkdays[issue.statusGroup] ?? 3;
      if (issue.workdaysInStatus >= threshold) {
        staleAlerts.push({
          issue,
          workdays: issue.workdaysInStatus,
          threshold,
          sinceDate: issue.statusSinceDate,
        });
      }
    }

    // GitHub PR <-> Jira Status Drift (4 Rules)
    const openPrs = issue.prs.filter((p) => p.state === 'OPEN');
    const openNonDraftPrs = openPrs.filter((p) => !p.isDraft);
    const mergedPrs = issue.prs.filter((p) => p.state === 'MERGED');

    // Rule 1: All PRs merged (at least 1 merged, 0 open) but Jira status is still IN_PROGRESS or IN_REVIEW
    if (mergedPrs.length > 0 && openPrs.length === 0 && ['IN_PROGRESS', 'IN_REVIEW'].includes(issue.statusGroup)) {
      const suggestedStatus = issue.type === 'Story' || issue.type === 'Bug' ? 'Waiting for QA' : 'Terminé(e)';
      prAlerts.push({
        rule: 'MERGED_NOT_UPDATED',
        severity: 'HIGH',
        icon: '🔴',
        issue,
        prs: mergedPrs,
        suggestedStatus,
        message: `${mergedPrs.length} PR(s) mergée(s) (0 ouverte), mais le ticket est toujours **${issue.status}** → Passer en **${suggestedStatus}** ?`,
      });
    }

    // Rule 2: Open non-draft PR waiting for review, but Jira ticket is still READY or IN_PROGRESS
    if (openNonDraftPrs.length > 0 && ['READY', 'IN_PROGRESS'].includes(issue.statusGroup)) {
      const allApproved = openNonDraftPrs.every((p) => p.reviewDecision === 'APPROVED');
      const suggestedStatus = allApproved ? 'Waiting Merge' : 'Revue en cours';
      prAlerts.push({
        rule: 'OPEN_PR_NOT_IN_REVIEW',
        severity: 'MEDIUM',
        icon: '🟠',
        issue,
        prs: openNonDraftPrs,
        suggestedStatus,
        message: `PR ouverte non-Draft (${openNonDraftPrs.map((p) => `${p.repo}#${p.number}${p.reviewDecision === 'APPROVED' ? ' ✅ APPROVED' : ''}`).join(', ')}) mais ticket toujours **${issue.status}** → Passer en **${suggestedStatus}** ?`,
      });
    }

    // Rule 3: PR Approved (while ticket still in Review instead of Waiting Merge) OR Changes Requested > 24h
    if (openNonDraftPrs.length > 0 && issue.statusGroup === 'IN_REVIEW') {
      const allApproved = openNonDraftPrs.every((p) => p.reviewDecision === 'APPROVED');
      if (allApproved && !isMergeWaitingStatus(issue.status)) {
        prAlerts.push({
          rule: 'PR_APPROVED_READY_TO_MERGE',
          severity: 'MEDIUM',
          icon: '🟡',
          issue,
          prs: openNonDraftPrs,
          suggestedStatus: 'Waiting Merge',
          message: `PR(s) **APPROVED** (${openNonDraftPrs.map((p) => `${p.repo}#${p.number}`).join(', ')}) prête(s) à merger, mais ticket toujours en **${issue.status}** → Passer en **Waiting Merge** / Merger ?`,
        });
      } else {
        const changesReqPrs = openNonDraftPrs.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED');
        for (const crPr of changesReqPrs) {
          const hoursSinceUpdate = (Date.now() - new Date(crPr.updatedAt).getTime()) / 3600000;
          if (hoursSinceUpdate >= cfg.prStaleReviewHours) {
            prAlerts.push({
              rule: 'PR_CHANGES_REQUESTED_STALE',
              severity: 'MEDIUM',
              icon: '🟡',
              issue,
              prs: [crPr],
              suggestedStatus: 'En cours',
              message: `PR ${crPr.repo}#${crPr.number} en **CHANGES_REQUESTED** sans mise à jour depuis ${Math.round(hoursSinceUpdate)}h (ticket en **${issue.status}**).`,
            });
          }
        }
      }
    }

    // Rule 4: Ticket in IN_REVIEW in Jira, but 0 PRs found on GitHub
    if (issue.statusGroup === 'IN_REVIEW' && issue.prs.length === 0) {
      const hasChildren = (storyChildrenMap.get(issue.key)?.size || 0) > 0;
      if (!hasChildren) {
        prAlerts.push({
          rule: 'IN_REVIEW_WITHOUT_PR',
          severity: 'LOW',
          icon: '⚪',
          issue,
          prs: [],
          suggestedStatus: null,
          message: `Ticket en **${issue.status}** dans Jira, mais **aucune PR trouvée** sur GitHub avec la clé \`${issue.key}\` dans le titre ou la branche.`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Dependency Unblocks & Hand-offs ("Next Ticket": FRONT / QA / Story / Blocks / Relates)
  // ---------------------------------------------------------------------------
  const seenUnblockKey = new Set();

  for (const issue of issueMap.values()) {
    const isCompletedOrQa = ['DONE', 'IN_QA'].includes(issue.statusGroup);
    const recentlyCompleted = issue.recentTransitions.some((t) => ['DONE', 'IN_QA'].includes(t.toGroup));

    if (!isCompletedOrQa) continue;

    // Rule A: Explicit Jira "Blocks" / "Gantt End to Start" outward links
    for (const link of issue.links) {
      const isBlockingOutward =
        (link.typeName === 'Blocks' && link.direction === 'outward') ||
        (link.typeName === 'Gantt End to Start' && link.direction === 'outward');

      if (isBlockingOutward && !['DONE', 'IN_QA'].includes(link.targetStatusGroup)) {
        const targetIssue = issueMap.get(link.targetKey);
        // Check if targetIssue still has OTHER unresolved inward blockers
        let otherActiveBlockers = [];
        if (targetIssue) {
          otherActiveBlockers = targetIssue.links.filter(
            (tl) =>
              ((tl.typeName === 'Blocks' && tl.direction === 'inward') ||
                (tl.typeName === 'Gantt End to Start' && tl.direction === 'inward')) &&
              tl.targetKey !== issue.key &&
              !['DONE', 'IN_QA'].includes(tl.targetStatusGroup)
          );
        }

        const dedup = `BLOCKS:${issue.key}->${link.targetKey}`;
        if (!seenUnblockKey.has(dedup)) {
          seenUnblockKey.add(dedup);
          const targetRole = targetIssue ? targetIssue.role : detectIssueRole({ key: link.targetKey, summary: link.targetSummary });
          const targetAssignee = targetIssue ? targetIssue.assignee : null;
          unblockAlerts.push({
            rule: 'EXPLICIT_BLOCKER_RESOLVED',
            isFresh: recentlyCompleted,
            icon: otherActiveBlockers.length === 0 ? '🟢' : '🟡',
            sourceIssue: issue,
            targetKey: link.targetKey,
            targetSummary: link.targetSummary,
            targetStatus: link.targetStatus,
            targetRole,
            targetAssignee,
            otherActiveBlockers,
            message:
              otherActiveBlockers.length === 0
                ? `**Déblocage direct (${targetRole})** : \`${issue.key}\` est **${issue.status}** → débloque **[${link.targetKey}](${cfg.jiraBaseUrl}${link.targetKey})** (*${link.targetSummary}*, statut : **${link.targetStatus}**${targetAssignee ? `, assigné : ${targetAssignee}` : ''}).`
                : `**Déblocage partiel (${targetRole})** : \`${issue.key}\` est **${issue.status}** pour **[${link.targetKey}](${cfg.jiraBaseUrl}${link.targetKey})**, mais reste bloqué par ${otherActiveBlockers.map((b) => `\`${b.targetKey}\` (${b.targetStatus})`).join(', ')}.`,
          });
        }
      }

      // Rule D: Soft "Relates" links when source ticket JUST moved to DONE / IN_QA since last daily
      if (link.typeName === 'Relates' && recentlyCompleted && !['DONE', 'IN_QA'].includes(link.targetStatusGroup)) {
        const targetIssue = issueMap.get(link.targetKey);
        if (targetIssue) {
          const dedup = `RELATES:${issue.key}->${link.targetKey}`;
          if (!seenUnblockKey.has(dedup)) {
            seenUnblockKey.add(dedup);
            unblockAlerts.push({
              rule: 'RELATES_HANDOFF',
              isFresh: true,
              icon: 'ℹ️',
              sourceIssue: issue,
              targetKey: link.targetKey,
              targetSummary: link.targetSummary,
              targetStatus: link.targetStatus,
              targetRole: targetIssue.role,
              targetAssignee: targetIssue.assignee,
              otherActiveBlockers: [],
              message: `**Lien connexe (\`Relates\`)** : \`${issue.key}\` vient de passer **${issue.status}** → vérifier l'impact sur **[${link.targetKey}](${cfg.jiraBaseUrl}${link.targetKey})** (*${link.targetSummary}*, **${link.targetStatus}**, ${targetIssue.assignee}).`,
            });
          }
        }
      }
    }
  }

  // Rule B & C: Story-level sibling hand-offs (BACK -> FRONT) & Story Completion -> Waiting for QA
  for (const [storyKey, childrenRefMap] of storyChildrenMap.entries()) {
    const story = issueMap.get(storyKey);
    if (!story) continue;

    const children = [];
    for (const [childKey, meta] of childrenRefMap.entries()) {
      const c = issueMap.get(childKey) || meta.fallbackChildInfo;
      if (c) children.push(c);
    }
    if (children.length === 0) continue;

    const backChildren = children.filter((c) => c.role === 'BACK' || c.role === '2CLOUD');
    const frontChildren = children.filter((c) => c.role === 'FRONT');
    const allChildrenDone = children.every((c) => c.statusGroup === 'DONE');
    const storyOpenPrs = story.prs.filter((p) => p.state === 'OPEN');

    // Rule C: All child tasks (BACK + FRONT) of a Story are DONE and the Story itself has 0 OPEN PRs,
    // yet the parent Story is still READY, IN_PROGRESS, or IN_REVIEW!
    if (allChildrenDone && storyOpenPrs.length === 0 && ['READY', 'IN_PROGRESS', 'IN_REVIEW'].includes(story.statusGroup)) {
      const qaTests = story.links.filter((l) => l.typeName === 'Test' || /^QA-/i.test(l.targetKey));
      const anyChildRecent = children.some((c) => c.recentTransitions.some((t) => t.toGroup === 'DONE'));
      const dedup = `STORY_QA:${story.key}`;
      if (!seenUnblockKey.has(dedup)) {
        seenUnblockKey.add(dedup);
        const qaSuffix =
          qaTests.length > 0
            ? ` (Tests QA liés : ${qaTests.map((q) => `[${q.targetKey}](${cfg.jiraBaseUrl}${q.targetKey}) [${q.targetStatus}]`).join(', ')})`
            : '';
        unblockAlerts.push({
          rule: 'STORY_READY_FOR_QA',
          isFresh: anyChildRecent,
          icon: '🚀',
          sourceIssue: children[children.length - 1],
          targetKey: story.key,
          targetSummary: story.summary,
          targetStatus: story.status,
          targetRole: 'QA / STORY',
          targetAssignee: story.assignee,
          otherActiveBlockers: [],
          suggestedStatus: 'Waiting for QA',
          message: `**Story prête pour QA** : 100% des tâches enfants (${children.map((c) => `\`${c.key}\``).join(', ')}) sont **Terminées**, mais la Story **[${story.key}](${story.url})** (*${story.summary}*) est encore **${story.status}** → Passer en **Waiting for QA** ?${qaSuffix}`,
        });
      }
    }

    // Rule B: Sibling BACK tasks are DONE, unlocking sibling FRONT tasks that are still READY or IN_PROGRESS
    if (backChildren.length > 0 && frontChildren.length > 0) {
      const doneBack = backChildren.filter((c) => c.statusGroup === 'DONE');
      const pendingBack = backChildren.filter((c) => c.statusGroup !== 'DONE');
      const activeOrTodoFront = frontChildren.filter((c) => ['READY', 'IN_PROGRESS'].includes(c.statusGroup));

      if (doneBack.length > 0 && pendingBack.length === 0 && activeOrTodoFront.length > 0) {
        const anyBackRecent = doneBack.some((c) => c.recentTransitions.some((t) => t.toGroup === 'DONE'));
        for (const frontTask of activeOrTodoFront) {
          const dedup = `SIBLING_BACK_FRONT:${story.key}->${frontTask.key}`;
          if (!seenUnblockKey.has(dedup)) {
            seenUnblockKey.add(dedup);
            unblockAlerts.push({
              rule: 'SIBLING_BACK_UNLOCKS_FRONT',
              isFresh: anyBackRecent,
              icon: '🎯',
              sourceIssue: doneBack[doneBack.length - 1],
              targetKey: frontTask.key,
              targetSummary: frontTask.summary,
              targetStatus: frontTask.status,
              targetRole: 'FRONT',
              targetAssignee: frontTask.assignee,
              otherActiveBlockers: [],
              message: `**Relais BACK → FRONT** (Story [${story.key}](${story.url})) : BACK terminé (${doneBack.map((b) => `\`${b.key}\``).join(', ')}) → débloque la tâche FRONT **[${frontTask.key}](${frontTask.url})** (*${frontTask.summary}*, **${frontTask.status}**, assigné : ${frontTask.assignee}).`,
            });
          }
        }
      }
    }
  }

  // Sort unblock alerts: fresh transitions first, then STORY_READY_FOR_QA, then SIBLING_BACK_UNLOCKS_FRONT, then EXPLICIT_BLOCKER_RESOLVED
  const rulePriority = {
    STORY_READY_FOR_QA: 1,
    SIBLING_BACK_UNLOCKS_FRONT: 2,
    EXPLICIT_BLOCKER_RESOLVED: 3,
    RELATES_HANDOFF: 4,
  };
  unblockAlerts.sort((a, b) => {
    if (a.isFresh !== b.isFresh) return a.isFresh ? -1 : 1;
    return (rulePriority[a.rule] || 9) - (rulePriority[b.rule] || 9);
  });

  staleAlerts.sort((a, b) => {
    const rankDiff =
      getStatusOrderRank(a.issue.status, a.issue.statusGroup) -
      getStatusOrderRank(b.issue.status, b.issue.statusGroup);
    return b.workdays - a.workdays || rankDiff;
  });

  const prRulePriority = {
    MERGED_NOT_UPDATED: 1,
    OPEN_PR_NOT_IN_REVIEW: 2,
    PR_APPROVED_READY_TO_MERGE: 3,
    PR_CHANGES_REQUESTED_STALE: 4,
    IN_REVIEW_WITHOUT_PR: 5,
  };
  prAlerts.sort(
    (a, b) =>
      (prRulePriority[a.rule] || 9) - (prRulePriority[b.rule] || 9) ||
      getStatusOrderRank(a.issue.status, a.issue.statusGroup) -
        getStatusOrderRank(b.issue.status, b.issue.statusGroup)
  );

  const roleOrder = { BACK: 1, '2CLOUD': 2, FRONT: 3, QA: 4, TASK: 5, STORY: 6 };
  const groupedChildKeys = new Set();

  // Build unified Story-First list for Story-by-Story Daily facilitation
  const allStoryKeys = new Set([...storyChildrenMap.keys()]);
  for (const issue of issueMap.values()) {
    if (issue.type === 'Story' && !groupedChildKeys.has(issue.key)) {
      allStoryKeys.add(issue.key);
    }
  }

  const storyGroups = [];

  for (const storyKey of allStoryKeys) {
    const story = issueMap.get(storyKey);
    if (!story) continue;
    const childrenRefMap = storyChildrenMap.get(storyKey) || new Map();
    const children = [...childrenRefMap.entries()]
      .map(([k, meta]) => issueMap.get(k) || meta.fallbackChildInfo)
      .filter(Boolean);

    // Sort children by status (Walk the Board: QA -> Waiting Merge -> Review -> En cours -> À faire -> Terminé)
    children.sort((a, b) => {
      const rankA = getStatusOrderRank(a.status, a.statusGroup);
      const rankB = getStatusOrderRank(b.status, b.statusGroup);
      if (rankA !== rankB) return rankA - rankB;
      return (roleOrder[a.role] || 9) - (roleOrder[b.role] || 9);
    });

    children.forEach((c) => groupedChildKeys.add(c.key));
    const qaTests = story.links.filter((l) => l.typeName === 'Test' || /^QA-/i.test(l.targetKey));
    const blockers = story.links.filter(
      (l) => l.typeName === 'Blocks' && l.direction === 'inward'
    );

    const doneCount = children.filter((c) => c.statusGroup === 'DONE').length;
    const totalCount = children.length;

    // Compute effective status group for the Story (if Story is marked "À faire" but has active children, promote it)
    let effectiveStatus = story.status;
    let effectiveStatusGroup = story.statusGroup;
    if (children.length > 0 && story.statusGroup === 'READY' && children.some((c) => c.statusGroup !== 'READY')) {
      if (children.every((c) => c.statusGroup === 'DONE')) {
        effectiveStatus = 'Prête pour QA';
        effectiveStatusGroup = 'IN_QA';
      } else if (children.some((c) => c.statusGroup === 'IN_REVIEW')) {
        effectiveStatus = 'En Revue (Sous-tâches)';
        effectiveStatusGroup = 'IN_REVIEW';
      } else {
        effectiveStatus = 'En cours (Sous-tâches)';
        effectiveStatusGroup = 'IN_PROGRESS';
      }
    }

    const relatedKeys = new Set([story.key, ...children.map((c) => c.key)]);
    const storyPrAlerts = prAlerts.filter((a) => relatedKeys.has(a.issue.key));
    const storyUnblocks = unblockAlerts.filter(
      (u) => relatedKeys.has(u.targetKey) || relatedKeys.has(u.sourceIssue.key)
    );
    const storyStale = staleAlerts.filter((s) => relatedKeys.has(s.issue.key));
    const storyMovements = recentMovements.filter((m) => relatedKeys.has(m.issue.key));

    storyGroups.push({
      story,
      effectiveStatus,
      effectiveStatusGroup,
      effectiveRank: getStatusOrderRank(effectiveStatus, effectiveStatusGroup),
      children,
      qaTests,
      blockers,
      doneCount,
      totalCount,
      storyPrAlerts,
      storyUnblocks,
      storyStale,
      storyMovements,
    });
  }

  storyGroups.sort((a, b) => {
    if (a.effectiveRank !== b.effectiveRank) return a.effectiveRank - b.effectiveRank;
    const alertsA = a.storyPrAlerts.length + a.storyUnblocks.length;
    const alertsB = b.storyPrAlerts.length + b.storyUnblocks.length;
    if (alertsB !== alertsA) return alertsB - alertsA;
    const pctA = a.totalCount > 0 ? a.doneCount / a.totalCount : 0;
    const pctB = b.totalCount > 0 ? b.doneCount / b.totalCount : 0;
    if (pctB !== pctA) return pctB - pctA;
    return a.story.key.localeCompare(b.story.key);
  });

  // Standalone tasks/bugs not inside storyGroups, sorted by status
  const standaloneIssues = [...issueMap.values()]
    .filter((i) => !allStoryKeys.has(i.key) && !groupedChildKeys.has(i.key))
    .sort((a, b) => {
      const rA = getStatusOrderRank(a.status, a.statusGroup);
      const rB = getStatusOrderRank(b.status, b.statusGroup);
      return rA - rB || b.workdaysInStatus - a.workdaysInStatus || a.key.localeCompare(b.key);
    });

  // Build Member groups for Section 4 (active sorted by status rank)
  const byMember = new Map();
  for (const issue of issueMap.values()) {
    const member = issue.assignee || 'Unassigned';
    if (!byMember.has(member)) {
      byMember.set(member, {
        member,
        active: [],
        ready: [],
        done: [],
      });
    }
    const bucket = byMember.get(member);
    if (issue.statusGroup === 'DONE') bucket.done.push(issue);
    else if (issue.statusGroup === 'READY') bucket.ready.push(issue);
    else bucket.active.push(issue);
  }

  for (const bucket of byMember.values()) {
    bucket.active.sort(
      (a, b) =>
        getStatusOrderRank(a.status, a.statusGroup) - getStatusOrderRank(b.status, b.statusGroup) ||
        b.workdaysInStatus - a.workdaysInStatus
    );
  }

  return {
    prAlerts,
    unblockAlerts,
    staleAlerts,
    recentMovements,
    storyGroups,
    standaloneIssues,
    byMember,
  };
}

function formatPrBadge(pr) {
  const stateIcon = pr.state === 'MERGED' ? '🟣 MERGED' : pr.isDraft ? '📝 DRAFT' : '🟢 OPEN';
  const rev =
    pr.state === 'OPEN' && !pr.isDraft
      ? pr.reviewDecision === 'APPROVED'
        ? ' ✅ APPROVED'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
        ? ' ❌ CHANGES_REQ'
        : ' 👀 REVIEW_REQ'
      : '';
  return `[${pr.repo}#${pr.number}](${pr.url}) (${stateIcon}${rev})`;
}

/**
 * Renders the Mixed-Format Markdown Daily Report for the Scrum Master.
 */
function renderMarkdownReport({
  targetDateStr,
  cutoffDateStr,
  activeSprintName,
  issueMap,
  analysis,
  cfg,
}) {
  const allIssues = [...issueMap.values()];
  const counts = {
    TOTAL: allIssues.length,
    READY: allIssues.filter((i) => i.statusGroup === 'READY').length,
    IN_PROGRESS: allIssues.filter((i) => i.statusGroup === 'IN_PROGRESS').length,
    IN_REVIEW: allIssues.filter((i) => i.statusGroup === 'IN_REVIEW').length,
    IN_QA: allIssues.filter((i) => i.statusGroup === 'IN_QA').length,
    DONE: allIssues.filter((i) => i.statusGroup === 'DONE').length,
  };

  const lines = [];
  lines.push(`# 🍿 Support d'Animation Daily — ${activeSprintName} (${targetDateStr})`);
  lines.push('');
  lines.push(
    `> **Fenêtre d'observation :** Changements depuis le **${cutoffDateStr}** | **Total Sprint :** **${counts.TOTAL}** tickets (**${counts.DONE}** Terminés · **${counts.IN_QA}** en QA · **${counts.IN_REVIEW}** en Revue/Merge · **${counts.IN_PROGRESS}** En cours · **${counts.READY}** À faire)`
  );
  lines.push('');

  // ===========================================================================
  // SECTION 1: FLASH ALERTES
  // ===========================================================================
  lines.push(`## 🚨 1. Flash Alertes du Matin (Actionnable au Daily)`);
  lines.push('');

  // 1A. GitHub PR <-> Jira Status Drift
  lines.push(`### 🔄 A. Désynchronisations GitHub PR ↔ Statut Jira (${analysis.prAlerts.length})`);
  if (analysis.prAlerts.length === 0) {
    lines.push(`✅ *Aucune désynchronisation détectée entre les PRs GitHub et les statuts Jira.*`);
  } else {
    for (const a of analysis.prAlerts) {
      const i = a.issue;
      lines.push(
        `- ${a.icon} **[${i.key}](${i.url})** (${i.role} · **${i.assignee}**) — *${i.summary}*`
      );
      lines.push(`  - ${a.message}`);
      if (a.prs.length > 0) {
        lines.push(`  - PR(s) : ${a.prs.map(formatPrBadge).join(' · ')}`);
      }
    }
  }
  lines.push('');

  // 1B. Dependency Unblocks & Next Tickets
  lines.push(`### 🔓 B. Déblocages & Relais "Next Ticket" (FRONT / QA / Blocks) (${analysis.unblockAlerts.length})`);
  if (analysis.unblockAlerts.length === 0) {
    lines.push(`*Aucun nouveau déblocage en attente d'action.*`);
  } else {
    for (const u of analysis.unblockAlerts) {
      const freshTag = u.isFresh ? ' 🔥 **[NOUVEAU]**' : '';
      lines.push(`- ${u.icon}${freshTag} ${u.message}`);
    }
  }
  lines.push('');

  // 1C. Stale / Aging WIP Tickets
  lines.push(
    `### ⏳ C. Tickets Stagnants hors "À faire" (${analysis.staleAlerts.length}) *(Seuils : En cours ≥ ${cfg.staleThresholdsWorkdays.IN_PROGRESS}j · Revue ≥ ${cfg.staleThresholdsWorkdays.IN_REVIEW}j · QA ≥ ${cfg.staleThresholdsWorkdays.IN_QA}j ouvrés)*`
  );
  if (analysis.staleAlerts.length === 0) {
    lines.push(`✅ *Aucun ticket actif ne dépasse les seuils de stagnation.*`);
  } else {
    lines.push(`| Ticket | Rôle | Statut actuel | Jours ouvrés | Depuis le | Assigné | PR(s) liée(s) |`);
    lines.push(`| :--- | :---: | :--- | :---: | :---: | :--- | :--- |`);
    for (const s of analysis.staleAlerts) {
      const i = s.issue;
      const prSummary =
        i.prs.length > 0
          ? i.prs
              .filter((p) => p.state !== 'CLOSED')
              .map(formatPrBadge)
              .join('<br>') || '—'
          : '—';
      lines.push(
        `| **[${i.key}](${i.url})** — ${i.summary.slice(0, 62)}${i.summary.length > 62 ? '…' : ''} | \`${i.role}\` | **${i.status}** | **${s.workdays}j** | ${s.sinceDate} | ${i.assignee} | ${prSummary} |`
      );
    }
  }
  lines.push('');

  // ===========================================================================
  // SECTION 2: MOUVEMENTS DEPUIS LE DERNIER DAILY
  // ===========================================================================
  lines.push(`## 🌊 2. Mouvements de Statut depuis le ${cutoffDateStr} (${analysis.recentMovements.length})`);
  lines.push('');
  if (analysis.recentMovements.length === 0) {
    lines.push(`*Aucun changement de statut enregistré sur les tickets du sprint depuis le ${cutoffDateStr}.*`);
  } else {
    for (const m of analysis.recentMovements) {
      const i = m.issue;
      lines.push(
        `- **[${i.key}](${i.url})** (\`${i.role}\` · **${i.assignee}**) : \`${m.from}\` ➔ **\`${m.to}\`** *(le ${m.dateStr} par ${m.author})* — *${i.summary}*`
      );
    }
  }
  lines.push('');

  // ===========================================================================
  // SECTION 3: VUE GROUPÉE PAR STORY / FEATURE
  // ===========================================================================
  const activeStoryGroups = analysis.storyGroups.filter(
    (g) => g.story.statusGroup !== 'DONE' || g.children.some((c) => c.statusGroup !== 'DONE')
  );
  lines.push(`## 🧩 3. Avancement par Story / Feature (${activeStoryGroups.length} actives)`);
  lines.push('');

  for (const g of activeStoryGroups) {
    const st = g.story;
    const pct = g.totalCount > 0 ? Math.round((g.doneCount / g.totalCount) * 100) : 0;
    const qaInfo =
      g.qaTests.length > 0
        ? ` · 🧪 QA : ${g.qaTests.map((q) => `[${q.targetKey}](${cfg.jiraBaseUrl}${q.targetKey}) (${q.targetStatus})`).join(', ')}`
        : '';
    lines.push(
      `### 📌 [${st.key}](${st.url}) — ${st.summary} [**${st.status}** · Tâches : **${g.doneCount}/${g.totalCount}** (${pct}%)${qaInfo}]`
    );
    for (const c of g.children) {
      const statusEmoji =
        c.statusGroup === 'DONE'
          ? '✅'
          : c.statusGroup === 'IN_QA'
          ? '🧪'
          : c.statusGroup === 'IN_REVIEW'
          ? '👀'
          : c.statusGroup === 'IN_PROGRESS'
          ? '🚧'
          : '⚪';
      const prText =
        c.prs.filter((p) => p.state !== 'CLOSED').length > 0
          ? ` — PR: ${c.prs
              .filter((p) => p.state !== 'CLOSED')
              .map(formatPrBadge)
              .join(', ')}`
          : '';
      const ageText =
        !['READY', 'DONE'].includes(c.statusGroup) && c.workdaysInStatus > 0
          ? ` *(${c.workdaysInStatus}j ouvrés)*`
          : '';
      lines.push(
        `  - ${statusEmoji} \`${c.role}\` **[${c.key}](${c.url})** [**${c.status}**${ageText}] (${c.assignee}) : ${c.summary}${prText}`
      );
    }
    lines.push('');
  }

  // ===========================================================================
  // SECTION 4: VUE TOUR DE TABLE PAR MEMBRE
  // ===========================================================================
  lines.push(`## 👥 4. Tour de Table par Membre de l'Équipe`);
  lines.push('');

  const sortedMembers = [...analysis.byMember.values()].sort((a, b) => {
    if (a.member === 'Unassigned') return 1;
    if (b.member === 'Unassigned') return -1;
    return b.active.length - a.active.length || a.member.localeCompare(b.member);
  });

  for (const m of sortedMembers) {
    if (m.active.length === 0 && m.ready.length === 0) continue;
    lines.push(
      `### 👤 ${m.member} *(Actifs : ${m.active.length} · À faire : ${m.ready.length} · Terminés : ${m.done.length})*`
    );
    if (m.active.length === 0) {
      lines.push(`- *Aucun ticket en cours / revue / QA actuellement.*`);
    } else {
      for (const i of m.active) {
        const prText =
          i.prs.filter((p) => p.state !== 'CLOSED').length > 0
            ? ` | PR : ${i.prs
                .filter((p) => p.state !== 'CLOSED')
                .map(formatPrBadge)
                .join(', ')}`
            : '';
        const blockers = i.links.filter(
          (l) =>
            l.typeName === 'Blocks' &&
            l.direction === 'inward' &&
            !['DONE', 'IN_QA'].includes(l.targetStatusGroup)
        );
        const blockerText =
          blockers.length > 0
            ? ` | ⛔ **Bloqué par :** ${blockers.map((b) => `[${b.targetKey}](${cfg.jiraBaseUrl}${b.targetKey}) (${b.targetStatus})`).join(', ')}`
            : '';
        lines.push(
          `- **[${i.key}](${i.url})** (\`${i.role}\` · **${i.status}** depuis ${i.workdaysInStatus}j ouvrés) — ${i.summary}${prText}${blockerText}`
        );
      }
    }
    if (m.ready.length > 0 && m.member !== 'Unassigned') {
      lines.push(
        `- *Prochains en "À faire" (${m.ready.length}) :* ${m.ready
          .map((r) => `[${r.key}](${r.url}) (\`${r.role}\` : ${r.summary.slice(0, 45)}…)`)
          .join(' · ')}`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Transitions a Jira issue to a target status name (only called on explicit user request).
 */
async function transitionJiraIssue(issueKey, targetStatusName, cfg, auth) {
  const baseUrl =
    auth.type === 'basic'
      ? 'https://ubitransport.atlassian.net/rest/api/3'
      : `https://api.atlassian.com/ex/jira/${cfg.cloudId}/rest/api/3`;
  const headers = { Authorization: auth.header, 'Content-Type': 'application/json' };

  const resT = await fetchWithTimeout(`${baseUrl}/issue/${issueKey}/transitions`, { headers });
  if (!resT.ok) {
    throw new Error(`Failed to fetch transitions for ${issueKey}: ${resT.status}`);
  }
  const dataT = await resT.json();
  const transitions = dataT.transitions || [];

  const match = transitions.find(
    (t) =>
      t.name.toLowerCase() === targetStatusName.toLowerCase() ||
      t.to?.name?.toLowerCase() === targetStatusName.toLowerCase()
  );

  if (!match) {
    const available = transitions.map((t) => `"${t.name}" (-> ${t.to?.name})`).join(', ');
    throw new Error(
      `Transition to "${targetStatusName}" not found for ${issueKey}. Available transitions: ${available}`
    );
  }

  const resPost = await fetchWithTimeout(`${baseUrl}/issue/${issueKey}/transitions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transition: { id: match.id } }),
  });

  if (!resPost.ok) {
    const errText = await resPost.text();
    throw new Error(`Failed to transition ${issueKey} (${resPost.status}): ${errText}`);
  }

  return { issueKey, transitionedTo: match.to?.name || match.name };
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'report';

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(`popcorn-daily v${VERSION}`);
    return;
  }

  const cfg = loadConfig();
  const auth = getJiraToken(cfg);

  if (cmd === 'transition') {
    const issueKey = args[1];
    const targetStatus = args[2];
    if (!issueKey || !targetStatus) {
      console.error('Usage: daily-engine.js transition <ISSUE_KEY> "<TARGET_STATUS>"');
      process.exit(1);
    }
    const res = await transitionJiraIssue(issueKey.toUpperCase(), targetStatus, cfg, auth);
    console.log(`✅ ${res.issueKey} transitioned to "${res.transitionedTo}"`);
    return;
  }

  // Parse optional flags: --date YYYY-MM-DD, --since-days N
  let targetDateStr = toParisDateString(new Date());
  let sinceWorkdays = 1;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--date' && args[i + 1]) {
      targetDateStr = args[++i];
    } else if (args[i] === '--since-days' && args[i + 1]) {
      sinceWorkdays = parseInt(args[++i], 10) || 1;
    }
  }

  const { cutoffDateStr, cutoffIso } = getPreviousWorkdayCutoff(
    targetDateStr,
    sinceWorkdays,
    cfg.frenchHolidays2026
  );

  const { rawIssues, externalIssueMap } = await fetchSprintData(cfg, auth);
  const { activeSprintName, issueMap } = normalizeIssues(rawIssues, targetDateStr, cutoffIso, cfg);
  await fetchGithubPrsForSprint(issueMap, cfg);
  const analysis = analyzeSprint(issueMap, externalIssueMap, cfg);

  // Save snapshot & markdown report
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

  const reportMd = renderMarkdownReport({
    targetDateStr,
    cutoffDateStr,
    activeSprintName,
    issueMap,
    analysis,
    cfg,
  });

  const reportPath = path.join(REPORTS_DIR, `${targetDateStr}.md`);
  const snapshotPath = path.join(SNAPSHOTS_DIR, `${targetDateStr}.json`);

  const allIssuesList = [...issueMap.values()];
  const counts = {
    totalIssues: allIssuesList.length,
    ready: allIssuesList.filter((i) => i.statusGroup === 'READY').length,
    inProgress: allIssuesList.filter((i) => i.statusGroup === 'IN_PROGRESS').length,
    inReview: allIssuesList.filter((i) => i.statusGroup === 'IN_REVIEW').length,
    inQa: allIssuesList.filter((i) => i.statusGroup === 'IN_QA').length,
    done: allIssuesList.filter((i) => i.statusGroup === 'DONE').length,
    prAlerts: analysis.prAlerts.length,
    unblockAlerts: analysis.unblockAlerts.length,
    staleAlerts: analysis.staleAlerts.length,
    recentMovements: analysis.recentMovements.length,
  };

  fs.writeFileSync(reportPath, reportMd, 'utf8');
  fs.writeFileSync(
    snapshotPath,
    JSON.stringify(
      {
        version: VERSION,
        generatedAt: new Date().toISOString(),
        targetDateStr,
        cutoffDateStr,
        activeSprintName,
        teamName: cfg.teamName,
        boardId: cfg.boardId,
        jiraBaseUrl: cfg.jiraBaseUrl,
        staleThresholdsWorkdays: cfg.staleThresholdsWorkdays,
        summaryCounts: counts,
        prAlerts: analysis.prAlerts.map((a) => ({
          rule: a.rule,
          severity: a.severity,
          icon: a.icon,
          key: a.issue.key,
          url: a.issue.url,
          summary: a.issue.summary,
          type: a.issue.type,
          role: a.issue.role,
          status: a.issue.status,
          statusGroup: a.issue.statusGroup,
          workdaysInStatus: a.issue.workdaysInStatus,
          assignee: a.issue.assignee,
          suggestedStatus: a.suggestedStatus,
          message: a.message,
          prs: a.prs,
        })),
        unblockAlerts: analysis.unblockAlerts.map((u) => ({
          rule: u.rule,
          isFresh: u.isFresh,
          icon: u.icon,
          sourceKey: u.sourceIssue.key,
          sourceUrl: u.sourceIssue.url,
          sourceSummary: u.sourceIssue.summary,
          sourceStatus: u.sourceIssue.status,
          sourceRole: u.sourceIssue.role,
          sourceAssignee: u.sourceIssue.assignee,
          targetKey: u.targetKey,
          targetUrl: `${cfg.jiraBaseUrl}${u.targetKey}`,
          targetSummary: u.targetSummary,
          targetStatus: u.targetStatus,
          targetRole: u.targetRole,
          targetAssignee: u.targetAssignee,
          otherActiveBlockers: u.otherActiveBlockers || [],
          suggestedStatus: u.suggestedStatus || null,
          message: u.message,
        })),
        staleAlerts: analysis.staleAlerts.map((s) => ({
          key: s.issue.key,
          url: s.issue.url,
          summary: s.issue.summary,
          type: s.issue.type,
          role: s.issue.role,
          status: s.issue.status,
          statusGroup: s.issue.statusGroup,
          workdays: s.workdays,
          threshold: s.threshold,
          sinceDate: s.sinceDate,
          assignee: s.issue.assignee,
          prs: s.issue.prs.filter((p) => p.state !== 'CLOSED'),
        })),
        recentMovements: analysis.recentMovements.map((m) => ({
          key: m.issue.key,
          url: m.issue.url,
          summary: m.issue.summary,
          type: m.issue.type,
          role: m.issue.role,
          status: m.issue.status,
          statusGroup: m.issue.statusGroup,
          assignee: m.issue.assignee,
          from: m.from,
          to: m.to,
          at: m.at,
          dateStr: m.dateStr,
          author: m.author,
          prs: m.issue.prs.filter((p) => p.state !== 'CLOSED'),
        })),
        storyGroups: analysis.storyGroups.map((g) => ({
          story: {
            key: g.story.key,
            url: g.story.url,
            summary: g.story.summary,
            type: g.story.type,
            role: g.story.role,
            status: g.story.status,
            statusGroup: g.story.statusGroup,
            effectiveStatus: g.effectiveStatus,
            effectiveStatusGroup: g.effectiveStatusGroup,
            effectiveRank: g.effectiveRank,
            assignee: g.story.assignee,
            epicKey: g.story.parent?.key || null,
            epicSummary: g.story.parent?.summary || null,
            workdaysInStatus: g.story.workdaysInStatus,
            sinceDate: g.story.statusSinceDate,
            prs: g.story.prs.filter((p) => p.state !== 'CLOSED'),
          },
          doneCount: g.doneCount,
          totalCount: g.totalCount,
          blockers: (g.blockers || []).map((b) => ({
            key: b.targetKey,
            url: `${cfg.jiraBaseUrl}${b.targetKey}`,
            summary: b.targetSummary,
            status: b.targetStatus,
            statusGroup: b.targetStatusGroup,
          })),
          qaTests: g.qaTests.map((q) => ({
            key: q.targetKey,
            url: `${cfg.jiraBaseUrl}${q.targetKey}`,
            summary: q.targetSummary,
            status: q.targetStatus,
            statusGroup: q.targetStatusGroup,
          })),
          children: g.children.map((c) => ({
            key: c.key,
            url: c.url,
            summary: c.summary,
            type: c.type,
            role: c.role,
            status: c.status,
            statusGroup: c.statusGroup,
            statusRank: getStatusOrderRank(c.status, c.statusGroup),
            assignee: c.assignee,
            workdaysInStatus: c.workdaysInStatus || 0,
            sinceDate: c.statusSinceDate || '',
            prs: (c.prs || []).filter((p) => p.state !== 'CLOSED'),
          })),
        })),
        standaloneIssues: analysis.standaloneIssues.map((i) => ({
          key: i.key,
          url: i.url,
          summary: i.summary,
          type: i.type,
          role: i.role,
          status: i.status,
          statusGroup: i.statusGroup,
          statusRank: getStatusOrderRank(i.status, i.statusGroup),
          assignee: i.assignee,
          epicKey: i.parent?.key || null,
          epicSummary: i.parent?.summary || null,
          workdaysInStatus: i.workdaysInStatus || 0,
          sinceDate: i.statusSinceDate,
          prs: (i.prs || []).filter((p) => p.state !== 'CLOSED'),
        })),
        members: [...analysis.byMember.values()].map((m) => ({
          member: m.member,
          active: m.active.map((i) => ({
            key: i.key,
            url: i.url,
            summary: i.summary,
            type: i.type,
            role: i.role,
            status: i.status,
            statusGroup: i.statusGroup,
            workdaysInStatus: i.workdaysInStatus,
            sinceDate: i.statusSinceDate,
            prs: i.prs.filter((p) => p.state !== 'CLOSED'),
            blockers: i.links
              .filter(
                (l) =>
                  l.typeName === 'Blocks' &&
                  l.direction === 'inward' &&
                  !['DONE', 'IN_QA'].includes(l.targetStatusGroup)
              )
              .map((b) => ({
                key: b.targetKey,
                url: `${cfg.jiraBaseUrl}${b.targetKey}`,
                summary: b.targetSummary,
                status: b.targetStatus,
              })),
          })),
          ready: m.ready.map((i) => ({
            key: i.key,
            url: i.url,
            summary: i.summary,
            type: i.type,
            role: i.role,
            status: i.status,
          })),
          done: m.done.map((i) => ({
            key: i.key,
            url: i.url,
            summary: i.summary,
            type: i.type,
            role: i.role,
            status: i.status,
          })),
        })),
      },
      null,
      2
    ),
    'utf8'
  );

  logProgress(`✅ Saved daily report to ${reportPath}`);

  if (cmd === 'json') {
    console.log(fs.readFileSync(snapshotPath, 'utf8'));
  } else {
    console.log(reportMd);
  }
}

main().catch((err) => {
  console.error(`❌ Error in popcorn-daily engine: ${err.message}`);
  process.exit(1);
});
