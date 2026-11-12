const state = {
  dates: [],
  currentDate: null,
  snapshot: null,
  sidebarTab: 'agenda', // 'agenda' (Stories with movement/waiting) | 'tasks' (Standalone tasks with movement/waiting) | 'ras' (Everything else)
  activeMode: 'story', // 'story' | 'members'
  searchQuery: '',
  selectedKey: null,
  reviewedKeys: new Set(),
  collapsedDetailsKeys: new Set(), // Technical subtask drawer is expanded by default
  theme: localStorage.getItem('popcorn-daily-theme') || 'dark',
};

document.documentElement.setAttribute('data-theme', state.theme);

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const JIRA_BROWSE_URL = 'https://ubitransport.atlassian.net/browse/';
const TEAM_QA_NAME = 'Christel FOMBA';

function firstName(fullName = '') {
  if (!fullName || fullName === 'Unassigned' || fullName === 'Non assigné' || fullName === 'External/Unassigned') {
    return null;
  }
  return fullName.trim().split(/\s+/)[0];
}

function personBadge(fullName, fallback = "l'équipe") {
  const fn = firstName(fullName);
  return `<span class="person-tag">${escapeHtml(fn || fallback)}</span>`;
}

function jiraLink(key) {
  if (!key) return '';
  return `<a class="inline-jira-link" href="${JIRA_BROWSE_URL}${encodeURIComponent(key)}" target="_blank" rel="noopener">${escapeHtml(key)}</a>`;
}

function prInlineLink(pr) {
  if (!pr || !pr.url) return '';
  return `<a class="inline-pr-link" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener">${escapeHtml(pr.repo)}#${pr.number}</a>`;
}

function isCurrentlyInQaTesting(status = '') {
  return /^in\s+qa$/i.test(String(status).trim()) || /recette\s+en\s+cours/i.test(String(status).trim());
}

function isWaitingForQaPickup(status = '') {
  return /waiting\s+for\s+qa/i.test(String(status).trim()) || /pr[êe]t.*qa/i.test(String(status).trim());
}

function showToast(msg, durationMs = 3200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.classList.add('hidden');
  }, durationMs);
}

function renderRoleBadge(role = 'TASK') {
  const clean = role.split('/')[0].trim();
  return `<span class="badge badge-role-${escapeHtml(clean)}">${escapeHtml(role)}</span>`;
}

function renderStatusBadge(status = '', statusGroup = 'IN_PROGRESS') {
  return `<span class="badge badge-status-${escapeHtml(statusGroup)}">${escapeHtml(status)}</span>`;
}

/**
 * Core Intelligence: Builds the 3 conversational blocks for a Story or Ticket:
 * 1. Why it is on today's agenda (moved yesterday OR waiting too long)
 * 2. What to say / ask aloud (with colleagues' first names & Christel for QA)
 * 3. What 1-click actions to take (strictly 1 row: [Ouvrir dans Jira] -> [Action Jira] -> [Sujet traité])
 */
function buildConversationalGuide(item) {
  const st = item.story;
  const children = item.children || [];
  const allTasks = [st, ...children];

  const facts = [];
  const jiraActions = []; // { key, targetStatus, label }
  const reasonPills = [];

  const addJiraAction = (key, targetStatus, customLabel = null) => {
    if (!key || !targetStatus) return;
    if (jiraActions.some((a) => a.key === key && a.targetStatus === targetStatus)) return;
    jiraActions.push({
      key,
      targetStatus,
      label: customLabel || `⚡ Passer ${key} en "${targetStatus}"`,
    });
  };

  // Rule A2: If the Story/Ticket is currently in "In QA" (< 2 workdays, i.e., not stale)
  // and has no unmerged PR drift or active child tasks, our QA (Christel) is actively testing it!
  // We keep it out of today's Daily Agenda so we only discuss "In QA" if it stagnates >= 2 workdays.
  const activeInQaNormal =
    isCurrentlyInQaTesting(st.status) &&
    item.staleList.length === 0 &&
    item.prAlerts.length === 0 &&
    children.every((c) => ['DONE', 'IN_QA'].includes(c.statusGroup));

  if (activeInQaNormal) {
    facts.push(
      `🧪 <strong>En cours de recette QA :</strong> ${personBadge(TEAM_QA_NAME)} est actuellement en train de tester ${jiraLink(st.key)} (statut <strong>${escapeHtml(st.status)}</strong> depuis &lt; 2j ouvrés).`
    );
    return {
      isOnAgenda: false,
      priorityGroup: 90,
      priorityHeader: '😌 R.A.S. (En test QA par Christel / En cours normal / Non démarrées)',
      reasonPills: [{ text: '🧪 En test (Christel)', cls: 'reason-moved' }],
      facts,
      jiraActions,
    };
  }

  // ---------------------------------------------------------------------------
  // A. Check what moved since the previous workday (Trigger 1: "A évolué la veille")
  // ---------------------------------------------------------------------------
  if (item.movements.length > 0) {
    reasonPills.push({ text: '🌊 A bougé hier', cls: 'reason-moved' });
    for (const mv of item.movements) {
      const who = firstName(mv.author) || firstName(mv.assignee) || 'Un membre';
      facts.push(
        `🌊 <strong>Évolution récente :</strong> <strong>${escapeHtml(who)}</strong> a passé ${jiraLink(mv.key)} (${escapeHtml(mv.role)}) de <em>${escapeHtml(mv.from)}</em> à <strong>${escapeHtml(mv.to)}</strong>.`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // B. Check if 100% of subtasks/PRs are done, waiting to move Story to QA
  // ---------------------------------------------------------------------------
  const allChildrenDone = children.length > 0 && children.every((c) => c.statusGroup === 'DONE');
  const allOpenPrs = allTasks.flatMap((t) => (t.prs || []).filter((p) => p.state === 'OPEN'));
  const storyReadyForQa =
    allChildrenDone && allOpenPrs.length === 0 && ['READY', 'IN_PROGRESS', 'IN_REVIEW'].includes(st.statusGroup);

  if (storyReadyForQa) {
    reasonPills.push({ text: '🔴 Prête pour QA', cls: 'reason-urgent' });
    facts.push(
      `✅ <strong>Développement terminé à 100% :</strong> Toutes les sous-tâches (${children.map((c) => jiraLink(c.key)).join(', ')}) sont terminées, mais la Story ${jiraLink(st.key)} est restée au statut <strong>${escapeHtml(st.status)}</strong>.`
    );
    const owner =
      st.assignee !== 'Unassigned'
        ? st.assignee
        : children[children.length - 1]?.assignee || null;
    addJiraAction(st.key, 'Waiting for QA');
  }

  // ---------------------------------------------------------------------------
  // C. Check GitHub PR <-> Jira Status Drifts (Merged / Approved / Open waiting review)
  // ---------------------------------------------------------------------------
  for (const a of item.prAlerts) {
    if (a.rule === 'MERGED_NOT_UPDATED') {
      if (!reasonPills.some((r) => r.text.includes('PR'))) {
        reasonPills.push({ text: '🔴 PR mergée (Jira oublié)', cls: 'reason-urgent' });
      }
      const prStr = a.prs.map((p) => prInlineLink(p)).join(', ');
      facts.push(
        `🟣 <strong>PR mergée sur GitHub :</strong> La PR ${prStr} sur ${jiraLink(a.key)} est mergée (0 PR ouverte), mais le ticket Jira est toujours en <strong>${escapeHtml(a.status)}</strong>.`
      );
      if (!storyReadyForQa || a.key !== st.key) {
        addJiraAction(a.key, a.suggestedStatus);
      }
    } else if (a.rule === 'PR_APPROVED_READY_TO_MERGE') {
      reasonPills.push({ text: '🚀 PR approuvée à merger', cls: 'reason-wait' });
      const prStr = a.prs.map((p) => prInlineLink(p)).join(', ');
      facts.push(
        `✅ <strong>PR approuvée en attente de merge :</strong> La PR ${prStr} sur ${jiraLink(a.key)} est <strong>APPROVED</strong>, mais le ticket est toujours en <strong>${escapeHtml(a.status)}</strong>.`
      );
      addJiraAction(a.key, a.suggestedStatus);
    } else if (a.rule === 'OPEN_PR_NOT_IN_REVIEW') {
      const allApproved = a.prs.every((p) => p.reviewDecision === 'APPROVED');
      reasonPills.push({
        text: allApproved ? '🚀 PR approuvée (Jira En cours)' : '🟠 PR ouverte (Jira En cours)',
        cls: 'reason-wait',
      });
      const prStr = a.prs.map((p) => prInlineLink(p)).join(', ');
      facts.push(
        `🟢 <strong>PR ouverte sur GitHub :</strong> ${prStr} est ${allApproved ? '<strong>approuvée</strong>' : 'ouverte en attente de review'}, mais ${jiraLink(a.key)} est encore au statut <strong>${escapeHtml(a.status)}</strong>.`
      );
      addJiraAction(a.key, a.suggestedStatus);
    }
  }

  // ---------------------------------------------------------------------------
  // D. Check Unblocked Tasks / Hand-offs (BACK -> FRONT / Blockers lifted)
  // ---------------------------------------------------------------------------
  const directUnblocks = item.unblocks.filter(
    (u) => (!u.otherActiveBlockers || u.otherActiveBlockers.length === 0) && u.rule !== 'STORY_READY_FOR_QA'
  );
  if (directUnblocks.length > 0) {
    reasonPills.push({ text: '🔓 Tâche débloquée', cls: 'reason-moved' });
    for (const u of directUnblocks) {
      const finisher = firstName(u.sourceAssignee) || "l'équipe";
      facts.push(
        `🔓 <strong>Déblocage (${escapeHtml(u.targetRole)}) :</strong> <strong>${escapeHtml(finisher)}</strong> a terminé ${jiraLink(u.sourceKey)}, ce qui débloque ${jiraLink(u.targetKey)} (<em>${escapeHtml(u.targetSummary)}</em> — actuellement <strong>${escapeHtml(u.targetStatus)}</strong>).`
      );
      const targetPerson = firstName(u.targetAssignee)
        ? personBadge(u.targetAssignee)
        : personBadge(null, `l'équipe ${u.targetRole}`);
    }
  } else if (children.length > 0) {
    // Check if some subtasks are DONE and remaining subtasks are still "À faire" without nobody in progress
    const doneKids = children.filter((c) => c.statusGroup === 'DONE');
    const inProgKids = children.filter((c) => ['IN_PROGRESS', 'IN_REVIEW', 'IN_QA'].includes(c.statusGroup));
    const readyKids = children.filter((c) => c.statusGroup === 'READY');
    if (doneKids.length > 0 && inProgKids.length === 0 && readyKids.length > 0) {
      reasonPills.push({ text: '🔓 Attend relais tâche suivante', cls: 'reason-wait' });
      const nextKid = readyKids[0];
      facts.push(
        `🔓 <strong>Relais en attente :</strong> ${doneKids.map((c) => `${jiraLink(c.key)} (${escapeHtml(c.role)})`).join(', ')} est terminé, mais la tâche suivante ${jiraLink(nextKid.key)} (<em>${escapeHtml(nextKid.summary)}</em>) est toujours <strong>À faire</strong>.`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // E. Check Stale / Waiting Too Long Tickets (Trigger 2: "Attend depuis trop longtemps")
  // ---------------------------------------------------------------------------
  for (const s of item.staleList) {
    // Avoid duplicating if we already talked about this exact ticket via a merged/approved PR alert
    const alreadyCoveredByPrAlert = item.prAlerts.some((a) => a.key === s.key);
    if (!reasonPills.some((r) => r.text.includes('j ouvrés'))) {
      reasonPills.push({ text: `⏳ Attend depuis ${s.workdays}j ouvrés`, cls: 'reason-urgent' });
    }

    if (s.statusGroup === 'IN_QA') {
      if (isCurrentlyInQaTesting(s.status)) {
        facts.push(
          `⏳ <strong>Test QA en cours (${s.workdays} jours ouvrés) :</strong> ${jiraLink(s.key)} (${escapeHtml(s.role)}) est au statut <strong>${escapeHtml(s.status)}</strong> avec ${personBadge(TEAM_QA_NAME)} depuis le ${escapeHtml(s.sinceDate)} (dev référent : ${escapeHtml(s.assignee)}).`
        );
      } else {
        facts.push(
          `⏳ <strong>En attente de prise en charge QA (${s.workdays} jours ouvrés) :</strong> ${jiraLink(s.key)} (${escapeHtml(s.role)}) attend en <strong>${escapeHtml(s.status)}</strong> depuis le ${escapeHtml(s.sinceDate)} (dev référent : ${escapeHtml(s.assignee)}).`
        );
      }
    } else {
      facts.push(
        `⏳ <strong>Stagnation (${s.workdays} jours ouvrés) :</strong> ${jiraLink(s.key)} (${escapeHtml(s.role)}) est au statut <strong>${escapeHtml(s.status)}</strong> depuis le ${escapeHtml(s.sinceDate)} (${escapeHtml(s.assignee)}).`
      );
    }

    if (!alreadyCoveredByPrAlert) {
      const openReviewPr = (s.prs || []).find((p) => p.state === 'OPEN' && !p.isDraft);
      if (openReviewPr && s.statusGroup === 'IN_REVIEW') {
      } else if (s.statusGroup === 'IN_QA') {
        if (isCurrentlyInQaTesting(s.status)) {
        } else {
          addJiraAction(s.key, 'In QA');
        }
      } else {
      }
    }
  }

  // If the item moved yesterday to Waiting for QA, allow quick action
  if (facts.length > 0 && item.movements.length > 0) {
    const lastMv = item.movements[item.movements.length - 1];
    if (isWaitingForQaPickup(lastMv.to)) {
      addJiraAction(lastMv.key, 'In QA');
    }
  }

  // Is this Story part of today's Daily Agenda?
  // Strict rule from user: "je passe en review toutes les story où un ticket a évolué la veille ou attend depuis trop longtemps"
  const isOnAgenda =
    st.statusGroup !== 'DONE' &&
    (item.movements.length > 0 ||
      storyReadyForQa ||
      item.prAlerts.length > 0 ||
      directUnblocks.length > 0 ||
      item.staleList.length > 0 ||
      reasonPills.length > 0);

  // Compute priority rank for ordering the Agenda:
  // 1. Ready for QA / Merged PRs not updated (fastest wins to close tickets!)
  // 2. Approved PRs waiting for Merge
  // 3. Unblocked tasks / Relais BACK -> FRONT
  // 4. Stale / Waiting for Review or QA
  // 5. Recent movements from yesterday
  let priorityGroup = 9;
  let priorityHeader = '😌 R.A.S. (En test QA par Christel / En cours normal / Non démarrées)';

  if (!isOnAgenda) {
    priorityGroup = st.statusGroup === 'DONE' ? 99 : st.statusGroup === 'READY' ? 95 : 90;
  } else if (storyReadyForQa || item.prAlerts.some((a) => a.rule === 'MERGED_NOT_UPDATED')) {
    priorityGroup = 1;
    priorityHeader = '🔴 1. Dev & PRs Terminés ➔ Statut Jira à basculer en QA / Terminé';
  } else if (
    item.prAlerts.some((a) => a.rule === 'PR_APPROVED_READY_TO_MERGE') ||
    allTasks.some((t) => /waiting merge/i.test(t.status))
  ) {
    priorityGroup = 2;
    priorityHeader = '🚀 2. PRs Approuvées ➔ En attente de Merge';
  } else if (directUnblocks.length > 0 || reasonPills.some((r) => r.text.includes('Relais') || r.text.includes('débloquée'))) {
    priorityGroup = 3;
    priorityHeader = '🔓 3. Évolutions d\'hier ➔ Relais BACK / FRONT à lancer';
  } else if (item.staleList.length > 0 || item.prAlerts.length > 0) {
    priorityGroup = 4;
    priorityHeader = '⏳ 4. En attente depuis plusieurs jours (Review / Dev / QA)';
  } else {
    priorityGroup = 5;
    priorityHeader = '🌊 5. Autres mouvements de la veille (Waiting for QA / Dev)';
  }

  if (facts.length === 0) {
    facts.push(
      `😌 <strong>R.A.S. ce matin :</strong> Aucun changement de statut hier et aucun dépassement de délai sur ${jiraLink(st.key)} (${escapeHtml(st.status)}).`
    );
  }


  return {
    isOnAgenda,
    priorityGroup,
    priorityHeader,
    reasonPills: reasonPills.slice(0, 3),
    facts,
    jiraActions,
  };
}

function buildUnifiedItems() {
  const snap = state.snapshot;
  if (!snap) return [];

  const prAlertsByKey = new Map();
  for (const a of snap.prAlerts || []) {
    if (!prAlertsByKey.has(a.key)) prAlertsByKey.set(a.key, []);
    prAlertsByKey.get(a.key).push(a);
  }

  const staleByKey = new Map();
  for (const s of snap.staleAlerts || []) {
    staleByKey.set(s.key, s);
  }

  const items = [];

  for (const g of snap.storyGroups || []) {
    const st = g.story;
    const relatedKeys = new Set([st.key, ...(g.children || []).map((c) => c.key)]);

    const item = {
      key: st.key,
      isStoryGroup: true,
      story: st,
      children: (g.children || []).map((c) => ({
        ...c,
        prAlerts: prAlertsByKey.get(c.key) || [],
        staleInfo: staleByKey.get(c.key) || null,
      })),
      doneCount: g.doneCount || 0,
      totalCount: g.totalCount || 0,
      qaTests: g.qaTests || [],
      blockers: g.blockers || [],
      prAlerts: (snap.prAlerts || []).filter((a) => relatedKeys.has(a.key)),
      unblocks: (snap.unblockAlerts || []).filter(
        (u) => relatedKeys.has(u.targetKey) || relatedKeys.has(u.sourceKey)
      ),
      staleList: (snap.staleAlerts || []).filter((s) => relatedKeys.has(s.key)),
      movements: (snap.recentMovements || []).filter((m) => relatedKeys.has(m.key)),
    };

    item.guide = buildConversationalGuide(item);
    items.push(item);
  }

  for (const sa of snap.standaloneIssues || []) {
    const item = {
      key: sa.key,
      isStoryGroup: false,
      story: sa,
      children: [],
      doneCount: sa.statusGroup === 'DONE' ? 1 : 0,
      totalCount: 0,
      qaTests: [],
      blockers: [],
      prAlerts: prAlertsByKey.get(sa.key) || [],
      unblocks: (snap.unblockAlerts || []).filter(
        (u) => u.targetKey === sa.key || u.sourceKey === sa.key
      ),
      staleList: staleByKey.has(sa.key) ? [staleByKey.get(sa.key)] : [],
      movements: (snap.recentMovements || []).filter((m) => m.key === sa.key),
    };

    item.guide = buildConversationalGuide(item);
    items.push(item);
  }

  items.sort((a, b) => {
    if (a.guide.priorityGroup !== b.guide.priorityGroup) {
      return a.guide.priorityGroup - b.guide.priorityGroup;
    }
    if (a.isStoryGroup !== b.isStoryGroup) return a.isStoryGroup ? -1 : 1;
    return a.key.localeCompare(b.key);
  });

  return items;
}

function filterItemsForTab(allItems) {
  return allItems.filter((item) => {
    if (state.sidebarTab === 'agenda') {
      if (!item.isStoryGroup || !item.guide.isOnAgenda) return false;
    } else if (state.sidebarTab === 'tasks') {
      if (item.isStoryGroup || !item.guide.isOnAgenda) return false;
    } else if (state.sidebarTab === 'ras') {
      if (item.guide.isOnAgenda) return false;
    }

    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const hay = [
        item.key,
        item.story.summary,
        item.story.assignee,
        ...item.guide.facts,
        ...item.children.map((c) => `${c.key} ${c.summary} ${c.assignee}`),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

function renderSidebar(allItems, tabItems) {
  const snap = state.snapshot;
  if (!snap) return;

  document.getElementById('sprintTitle').textContent = snap.activeSprintName || 'Popcorn Daily';
  document.getElementById('versionBadge').textContent = 'v2.2.0';
  document.getElementById('sprintSubtitle').textContent = `Évolutions depuis le ${snap.cutoffDateStr}`;

  const dateSelect = document.getElementById('dateSelect');
  dateSelect.innerHTML = state.dates
    .map((d) => `<option value="${escapeHtml(d)}" ${d === state.currentDate ? 'selected' : ''}>${escapeHtml(d)}</option>`)
    .join('');

  // Mini meter
  const c = snap.summaryCounts || {};
  const total = c.totalIssues || 1;
  const pct = (n) => Math.round(((n || 0) / total) * 100);
  document.getElementById('miniMeterLabels').innerHTML = `
    <span>🧪 ${c.inQa || 0} QA</span>
    <span>👀 ${c.inReview || 0} Revue</span>
    <span>🚧 ${c.inProgress || 0} En cours</span>
    <span>✅ ${c.done || 0}/${c.totalIssues || 0} (${pct(c.done)}%)</span>
  `;
  document.getElementById('miniMeterBar').innerHTML = `
    <div class="meter-seg" style="width:${pct(c.done)}%;background:var(--color-done)"></div>
    <div class="meter-seg" style="width:${pct(c.inQa)}%;background:var(--color-qa)"></div>
    <div class="meter-seg" style="width:${pct(c.inReview)}%;background:var(--color-review)"></div>
    <div class="meter-seg" style="width:${pct(c.inProgress)}%;background:var(--color-progress)"></div>
    <div class="meter-seg" style="width:${pct(c.ready)}%;background:var(--color-ready)"></div>
  `;

  const agendaStoriesCount = allItems.filter((i) => i.isStoryGroup && i.guide.isOnAgenda).length;
  const agendaTasksCount = allItems.filter((i) => !i.isStoryGroup && i.guide.isOnAgenda).length;
  const rasCount = allItems.filter((i) => !i.guide.isOnAgenda).length;

  document.getElementById('count-agenda').textContent = agendaStoriesCount;
  document.getElementById('count-tasks').textContent = agendaTasksCount;
  document.getElementById('count-ras').textContent = rasCount;

  const reviewedCount = tabItems.filter((i) => state.reviewedKeys.has(i.key)).length;
  document.getElementById('reviewedProgressLabel').textContent = `${reviewedCount}/${tabItems.length} traités`;

  if (!state.selectedKey || !tabItems.some((i) => i.key === state.selectedKey)) {
    state.selectedKey = tabItems[0]?.key || null;
  }

  const listEl = document.getElementById('storyList');
  if (tabItems.length === 0) {
    listEl.innerHTML = `<div class="empty-state">🎉 Aucun sujet dans cet onglet !</div>`;
    return;
  }

  let html = '';
  let lastGroup = null;
  let orderCounter = 1;

  for (const item of tabItems) {
    const pg = item.guide.priorityGroup;
    if (pg !== lastGroup) {
      lastGroup = pg;
      html += `
        <div class="sidebar-stage-header">
          <span>${escapeHtml(item.guide.priorityHeader)}</span>
        </div>
      `;
    }

    const isSelected = item.key === state.selectedKey;
    const isReviewed = state.reviewedKeys.has(item.key);
    const pillsHtml = item.guide.reasonPills
      .map((p) => `<span class="reason-pill ${p.cls}">${escapeHtml(p.text)}</span>`)
      .join('');

    html += `
      <div class="story-nav-item ${isSelected ? 'active' : ''} ${isReviewed ? 'nav-done' : ''}" data-key="${escapeHtml(item.key)}">
        <span class="nav-check js-toggle-reviewed" data-key="${escapeHtml(item.key)}" title="Marquer comme traité (Espace)">${isReviewed ? '✓' : ''}</span>
        <div class="nav-body">
          <div class="nav-top-row">
            <div style="display:flex;align-items:center;gap:6px">
              <span class="order-num">#${orderCounter++}</span>
              <span class="nav-key">${escapeHtml(item.key)}</span>
              ${!item.isStoryGroup ? renderRoleBadge(item.story.role) : ''}
            </div>
            ${renderStatusBadge(item.story.status, item.story.statusGroup)}
          </div>
          <div class="nav-title">${escapeHtml(item.story.summary)}</div>
          ${pillsHtml ? `<div class="nav-reason-tags">${pillsHtml}</div>` : ''}
        </div>
      </div>
    `;
  }

  listEl.innerHTML = html;
}

function renderPrPills(prs = []) {
  if (!prs || prs.length === 0) return '';
  return `<div class="pr-pills">${prs
    .map((p) => {
      const icon = p.state === 'MERGED' ? '🟣' : p.isDraft ? '📝' : '🟢';
      const rev =
        p.state === 'OPEN' && !p.isDraft
          ? p.reviewDecision === 'APPROVED'
            ? ' ✅ APPROVED'
            : p.reviewDecision === 'CHANGES_REQUESTED'
            ? ' ❌ CHANGES_REQ'
            : ' 👀 REVIEW_REQ'
          : p.state === 'MERGED'
          ? ' MERGED'
          : '';
      return `<a class="pr-pill" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${icon} ${escapeHtml(p.repo)}#${p.number}${rev}</a>`;
    })
    .join('')}</div>`;
}

function renderCleanTaskRow(task) {
  const icon =
    task.statusGroup === 'DONE'
      ? '✅'
      : task.statusGroup === 'IN_QA'
      ? '🧪'
      : task.statusGroup === 'IN_REVIEW'
      ? '👀'
      : task.statusGroup === 'IN_PROGRESS'
      ? '🚧'
      : '⚪';

  const hasPrs = task.prs && task.prs.length > 0;
  const workdays = task.workdaysInStatus || task.staleInfo?.workdays || 0;
  const ageBadge =
    !['READY', 'DONE'].includes(task.statusGroup) && workdays > 0
      ? `<span class="badge ${task.staleInfo ? 'badge-stale' : 'badge-subtle'}">${workdays}j ouvrés</span>`
      : '';

  return `
    <div class="task-row ${task.statusGroup === 'DONE' ? 'task-done' : ''}">
      <div class="task-main-line">
        <div class="task-left">
          <span>${icon}</span>
          ${renderRoleBadge(task.role)}
          <a class="issue-link" href="${escapeHtml(task.url)}" target="_blank" rel="noopener">${escapeHtml(task.key)}</a>
          <span class="task-summary">${escapeHtml(task.summary)}</span>
        </div>
        <div class="task-right">
          ${renderStatusBadge(task.status, task.statusGroup)}
          ${ageBadge}
          <span class="badge badge-subtle">👤 ${escapeHtml(task.assignee || 'Non assigné')}</span>
        </div>
      </div>
      ${hasPrs ? `<div class="task-sub-line">${renderPrPills(task.prs)}</div>` : ''}
    </div>
  `;
}

/**
 * Renders the 3 Ultra-Simple Conversational Blocks for the selected Story
 */
function renderStoryGuideStage(tabItems) {
  const container = document.getElementById('storyDetailStage');
  const item = tabItems.find((i) => i.key === state.selectedKey);

  if (!item) {
    container.innerHTML = `<div class="empty-state">Sélectionne un sujet dans l'Agenda à gauche.</div>`;
    return;
  }

  const st = item.story;
  const g = item.guide;
  const idx = tabItems.findIndex((i) => i.key === item.key);
  const isReviewed = state.reviewedKeys.has(item.key);
  const isDetailsExpanded = !state.collapsedDetailsKeys.has(item.key);

  const totalDetailsCount =
    item.children.length + (st.prs?.length || 0) + item.qaTests.length;

  const primaryJiraAction = g.jiraActions && g.jiraActions.length > 0 ? g.jiraActions[0] : null;
  const headerOwnerLabel = isCurrentlyInQaTesting(st.status)
    ? `🧪 ${TEAM_QA_NAME} (QA) · Dev : ${st.assignee !== 'Unassigned' ? st.assignee : 'Popcorn'}`
    : `👤 ${st.assignee !== 'Unassigned' ? st.assignee : 'Équipe Popcorn'}`;

  container.innerHTML = `
    <!-- Top Story Identification Header -->
    <div class="guide-header-card">
      <div class="guide-header-top">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="badge badge-subtle">Sujet #${idx + 1} / ${tabItems.length}</span>
          ${renderRoleBadge(item.isStoryGroup ? 'STORY' : st.role)}
          <a class="issue-link" style="font-size:15px" href="${escapeHtml(st.url)}" target="_blank" rel="noopener">${escapeHtml(st.key)}</a>
          ${renderStatusBadge(st.status, st.statusGroup)}
          ${item.totalCount > 0 ? `<span class="badge badge-subtle">📋 ${item.doneCount}/${item.totalCount} sous-tâches finies</span>` : ''}
        </div>
        <span class="badge badge-subtle">${escapeHtml(headerOwnerLabel)}</span>
      </div>
      <h2 class="guide-title">${escapeHtml(st.summary)}</h2>
    </div>

    <!-- TIROIR TECHNIQUE REPLIÉ PAR DÉFAUT (SOUS-TÂCHES, PRs, QA) -->
    ${
      totalDetailsCount > 0
        ? `
      <div class="details-drawer">
        <div class="details-drawer-header" id="toggleDetailsDrawerBtn">
          <span>${isDetailsExpanded ? '▼ Masquer' : '▶ Voir'} le détail technique (${item.children.length} sous-tâche(s) · ${item.qaTests.length} test(s) QA)</span>
          <span class="badge badge-subtle">${isDetailsExpanded ? 'Replier' : 'Déplier'}</span>
        </div>
        ${
          isDetailsExpanded
            ? `
          <div class="details-drawer-body">
            ${st.prs && st.prs.length > 0 ? `<div><strong>PR(s) sur la Story :</strong> ${renderPrPills(st.prs)}</div>` : ''}
            ${
              item.children.length > 0
                ? `<div class="tasks-stack">${item.children.map(renderCleanTaskRow).join('')}</div>`
                : ''
            }
            ${
              item.qaTests.length > 0
                ? `<div class="tasks-stack">${item.qaTests
                    .map(
                      (q) => `
                  <div class="task-row">
                    <div class="task-main-line">
                      <div class="task-left">
                        <span>🧪</span>
                        <span class="badge badge-role-QA">QA</span>
                        <a class="issue-link" href="${escapeHtml(q.url)}" target="_blank">${escapeHtml(q.key)}</a>
                        <span class="task-summary">${escapeHtml(q.summary)}</span>
                      </div>
                      <div class="task-right">
                        ${renderStatusBadge(q.status, q.statusGroup)}
                      </div>
                    </div>
                  </div>
                `
                    )
                    .join('')}</div>`
                : ''
            }
          </div>
        `
            : ''
        }
      </div>
    `
        : ''
    }

    <!-- BLOC 1: POURQUOI ON EN PARLE CE MATIN (LE FAIT) -->
    <div class="guide-block block-facts">
      <h3 class="block-label">📍 1. Pourquoi on en parle ce matin (Ce qui a bougé hier / Ce qui attend)</h3>
      <ul class="facts-list">
        ${g.facts.map((f) => `<li>${f}</li>`).join('')}
      </ul>
    </div>

    <!-- BLOC 2: QUELLES ACTIONS RÉALISER EN 1 CLIC (3 boutons alignés de même taille) -->
    <div class="guide-block block-actions">
      <h3 class="block-label">⚡ 2. Actions rapides en séance</h3>
      <div class="actions-grid">
        <a class="btn-action-bar btn-open-jira" href="${escapeHtml(st.url)}" target="_blank" rel="noopener">
          ↗ Ouvrir ${escapeHtml(st.key)} dans Jira
        </a>
        ${
          primaryJiraAction
            ? `
          <button class="btn-action-bar btn-action-jira js-transition-btn" data-key="${escapeHtml(primaryJiraAction.key)}" data-status="${escapeHtml(primaryJiraAction.targetStatus)}">
            ${escapeHtml(primaryJiraAction.label)}
          </button>
        `
            : ''
        }
        <button class="btn-action-bar btn-next-subject" id="doneAndNextBtn">
          ${isReviewed ? '✅ Sujet traité — Suivant →' : '✅ Sujet traité — Passer au suivant (Espace)'}
        </button>
      </div>
    </div>
  `;

  const doneNextBtn = document.getElementById('doneAndNextBtn');
  if (doneNextBtn) {
    doneNextBtn.addEventListener('click', () => {
      markDoneAndAdvance(tabItems);
    });
  }

  const drawerBtn = document.getElementById('toggleDetailsDrawerBtn');
  if (drawerBtn) {
    drawerBtn.addEventListener('click', () => {
      if (state.collapsedDetailsKeys.has(item.key)) {
        state.collapsedDetailsKeys.delete(item.key);
      } else {
        state.collapsedDetailsKeys.add(item.key);
      }
      renderAll();
    });
  }
}

function renderMembersStage() {
  const snap = state.snapshot;
  if (!snap) return;
  const container = document.getElementById('membersStage');

  // Re-attribute tickets that are currently in "In QA" to our QA (Christel FOMBA)
  const memberBuckets = new Map();
  const ensureMember = (name) => {
    if (!memberBuckets.has(name)) {
      memberBuckets.set(name, { member: name, active: [], doneCount: 0 });
    }
    return memberBuckets.get(name);
  };

  for (const m of snap.members || []) {
    const bucket = ensureMember(m.member);
    bucket.doneCount += (m.done || []).length;
    for (const t of m.active || []) {
      if (isCurrentlyInQaTesting(t.status)) {
        const qaBucket = ensureMember(`${TEAM_QA_NAME} (QA)`);
        qaBucket.active.push({
          ...t,
          assignee: `${TEAM_QA_NAME} (Dev : ${t.assignee})`,
        });
      } else {
        bucket.active.push(t);
      }
    }
  }

  const members = [...memberBuckets.values()]
    .filter((m) => m.active.length > 0)
    .sort((a, b) => {
      if (a.member === 'Unassigned') return 1;
      if (b.member === 'Unassigned') return -1;
      if (a.member.includes(TEAM_QA_NAME)) return -1;
      if (b.member.includes(TEAM_QA_NAME)) return 1;
      return b.active.length - a.active.length || a.member.localeCompare(b.member);
    });

  container.innerHTML = members
    .map(
      (m) => `
      <div class="guide-block">
        <h3 class="block-label">👤 ${escapeHtml(m.member)} (${m.active.length} ticket(s) actif(s) · ${m.doneCount} terminé(s))</h3>
        <div class="tasks-stack">
          ${m.active.map(renderCleanTaskRow).join('')}
        </div>
      </div>
    `
    )
    .join('');
}

function toggleStoryReviewed(key) {
  if (!key) return;
  if (state.reviewedKeys.has(key)) {
    state.reviewedKeys.delete(key);
  } else {
    state.reviewedKeys.add(key);
  }
  renderAll();
}

function markDoneAndAdvance(tabItems) {
  if (!state.selectedKey) return;
  state.reviewedKeys.add(state.selectedKey);

  const idx = tabItems.findIndex((i) => i.key === state.selectedKey);
  // Find next unreviewed item, or simply next item
  const nextUnreviewed =
    tabItems.slice(idx + 1).find((i) => !state.reviewedKeys.has(i.key)) ||
    tabItems[Math.min(tabItems.length - 1, idx + 1)];

  if (nextUnreviewed) {
    state.selectedKey = nextUnreviewed.key;
  }
  renderAll();

  const activeEl = document.querySelector(`.story-nav-item[data-key="${state.selectedKey}"]`);
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function navigateStory(delta) {
  const allItems = buildUnifiedItems();
  const tabItems = filterItemsForTab(allItems);
  if (tabItems.length === 0) return;

  const idx = tabItems.findIndex((i) => i.key === state.selectedKey);
  const nextIdx = Math.max(0, Math.min(tabItems.length - 1, (idx === -1 ? 0 : idx) + delta));
  state.selectedKey = tabItems[nextIdx].key;
  renderAll();

  const activeEl = document.querySelector(`.story-nav-item[data-key="${state.selectedKey}"]`);
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function switchMode(mode) {
  state.activeMode = mode;
  document.querySelectorAll('.mode-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.getElementById('mode-story').classList.toggle('hidden', mode !== 'story');
  document.getElementById('mode-members').classList.toggle('hidden', mode !== 'members');
}

function renderAll() {
  const allItems = buildUnifiedItems();
  const tabItems = filterItemsForTab(allItems);
  renderSidebar(allItems, tabItems);
  renderStoryGuideStage(tabItems);
  renderMembersStage();
}

async function openSetupModal(errorMessage = '') {
  const modal = document.getElementById('setupModal');
  const errBanner = document.getElementById('setupErrorBanner');
  if (!modal) return;

  if (errorMessage) {
    errBanner.textContent = `⚠️ ${errorMessage}`;
    errBanner.classList.remove('hidden');
  } else {
    errBanner.classList.add('hidden');
  }

  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg.email) {
      document.getElementById('cfgEmail').value = cfg.email;
    }
    if (cfg.hasJiraToken) {
      document.getElementById('cfgJiraToken').placeholder = '✅ Déjà configuré (laisse vide pour garder l\'actuel)';
    }
    if (cfg.hasGithubToken) {
      document.getElementById('cfgGithubToken').placeholder = '✅ Déjà configuré (laisse vide pour garder l\'actuel)';
    }
  } catch {}

  modal.classList.remove('hidden');
}

function closeSetupModal() {
  const modal = document.getElementById('setupModal');
  if (modal) modal.classList.add('hidden');
}

async function saveSetupAndSync() {
  const email = document.getElementById('cfgEmail').value.trim();
  const jiraApiToken = document.getElementById('cfgJiraToken').value.trim();
  const githubToken = document.getElementById('cfgGithubToken').value.trim();
  const saveBtn = document.getElementById('saveSetupBtn');
  const errBanner = document.getElementById('setupErrorBanner');

  saveBtn.disabled = true;
  saveBtn.textContent = '⏳ Vérification & Synchronisation Jira/GitHub en cours...';
  errBanner.classList.add('hidden');

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, jiraApiToken, githubToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Identifiants Jira invalides');
    }
    state.dates = data.dates || [];
    state.currentDate = data.currentDate;
    state.snapshot = data.snapshot;
    closeSetupModal();
    renderAll();
    showToast('✅ Accès enregistrés et Agenda du Daily synchronisé !');
  } catch (err) {
    errBanner.textContent = `❌ ${err.message}`;
    errBanner.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '🚀 Enregistrer mes accès et lancer le Daily';
  }
}

async function loadState(date = '') {
  try {
    const query = date ? `?date=${encodeURIComponent(date)}` : '';
    const res = await fetch(`/api/state${query}`);
    const data = await res.json();
    state.dates = data.dates || [];
    state.currentDate = data.currentDate;
    state.snapshot = data.snapshot;

    if (data.needsSetup) {
      openSetupModal(data.authError || '');
    }
    if (state.snapshot) {
      renderAll();
    }
  } catch (err) {
    showToast(`❌ Erreur : ${err.message}`);
  }
}

async function triggerLiveRefresh() {
  const spinner = document.getElementById('refreshSpinner');
  const btn = document.getElementById('refreshBtn');
  spinner.classList.remove('hidden');
  btn.disabled = true;
  showToast('⏳ Synchronisation Jira & GitHub en cours...');

  try {
    const res = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sinceDays: 1 }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.needsSetup) {
        openSetupModal(data.error);
      }
      throw new Error(data.error || 'Refresh failed');
    }
    state.dates = data.dates || [];
    state.currentDate = data.currentDate;
    state.snapshot = data.snapshot;
    renderAll();
    showToast('✅ Agenda du Daily mis à jour avec Jira & GitHub !');
  } catch (err) {
    showToast(`❌ Échec : ${err.message}`);
  } finally {
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
}

async function triggerJiraTransition(key, targetStatus, buttonEl) {
  if (buttonEl) buttonEl.disabled = true;
  showToast(`⏳ Passage de ${key} vers "${targetStatus}" dans Jira...`);

  try {
    const res = await fetch('/api/transition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        targetStatus,
        date: state.currentDate,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Transition failed');
    showToast(`✅ ${key} passé en "${targetStatus}" !`);
    await loadState(state.currentDate);
  } catch (err) {
    showToast(`❌ ${err.message}`, 5500);
    if (buttonEl) buttonEl.disabled = false;
  }
}

// Event Listeners
document.getElementById('sidebarFilterTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.filter-tab');
  if (!tab) return;
  state.sidebarTab = tab.dataset.tab;
  state.selectedKey = null;
  document.querySelectorAll('.filter-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === state.sidebarTab);
  });
  renderAll();
});

document.getElementById('modeTabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-tab');
  if (btn && btn.dataset.mode) {
    switchMode(btn.dataset.mode);
  }
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  state.searchQuery = e.target.value.trim();
  renderAll();
});

document.getElementById('dateSelect').addEventListener('change', (e) => {
  loadState(e.target.value);
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  triggerLiveRefresh();
});

document.getElementById('openSetupBtn')?.addEventListener('click', () => {
  openSetupModal();
});

document.getElementById('closeSetupBtn')?.addEventListener('click', () => {
  closeSetupModal();
});

document.getElementById('saveSetupBtn')?.addEventListener('click', () => {
  saveSetupAndSync();
});

document.getElementById('themeToggleBtn').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  localStorage.setItem('popcorn-daily-theme', state.theme);
});

document.getElementById('storyList').addEventListener('click', (e) => {
  const check = e.target.closest('.js-toggle-reviewed');
  if (check) {
    e.stopPropagation();
    toggleStoryReviewed(check.dataset.key);
    return;
  }
  const item = e.target.closest('.story-nav-item');
  if (item) {
    state.selectedKey = item.dataset.key;
    if (state.activeMode !== 'story') switchMode('story');
    renderAll();
  }
});

document.querySelector('.main-area').addEventListener('click', (e) => {
  const transBtn = e.target.closest('.js-transition-btn');
  if (transBtn) {
    triggerJiraTransition(transBtn.dataset.key, transBtn.dataset.status, transBtn);
  }
});

// Keyboard Shortcuts
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }

  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault();
    navigateStory(1);
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault();
    navigateStory(-1);
  } else if (e.key === ' ') {
    e.preventDefault();
    const allItems = buildUnifiedItems();
    const tabItems = filterItemsForTab(allItems);
    markDoneAndAdvance(tabItems);
  } else if (e.key === '1') {
    switchMode('story');
  } else if (e.key === '2') {
    switchMode('members');
  } else if (e.key === '/') {
    e.preventDefault();
    document.getElementById('searchInput').focus();
  } else if (e.key === 't') {
    document.getElementById('themeToggleBtn').click();
  } else if (e.key === 'r') {
    triggerLiveRefresh();
  }
});

loadState();
