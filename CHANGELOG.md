# Changelog — Popcorn Daily (`popcorn-daily`)

All notable changes to the `popcorn-daily` Scrum Master & Daily Standup Assistant skill are documented in this file.
This project adheres to [Semantic Versioning](https://semver.org/).

---

## [2.2.0] — 2026-11-10

### Added & Fixed
- **Zero-Tech PO Onboarding & 1-Click macOS Installer (`setup-mac.sh`, `Lancer Popcorn Daily.command`, `ui/index.html`, `ui/server.mjs`):**
  - Added `setup-mac.sh` for 1-line installation (`curl -fsSL https://raw.githubusercontent.com/fawr-ubi/popcorn-daily/main/setup-mac.sh | bash`) that downloads portable Node.js if missing (no Homebrew or admin password required), clones the repo, and places a double-clickable **`🍿 Popcorn Daily.command`** launcher on the macOS Desktop with automatic `git pull` updates.
  - Added a graphical **⚙️ Accès (Configuration Rapide)** modal inside the Web UI (`http://localhost:4343`) so a non-technical PO can paste their Jira email, Jira API token, and GitHub token directly in the browser without `acli` or `gh` CLI.
  - Added native HTTPS GitHub GraphQL fetching in `scripts/daily-engine.js` when `githubToken` is configured in `~/.config/popcorn-daily/config.json`.
- **Automatic Daily Sync & Token Refresh Fix (`scripts/daily-engine.js`, `ui/server.mjs`):**
  - Fixed morning sync failure (`401 Unauthorized`) when `acli` OAuth token expired by refreshing against `PRD-17449` and automatically retrying on `401`.
  - Automatically triggers a fresh sync when opening `http://localhost:4343` on a new calendar day (`todayStr !== dates[0]`).

---

## [2.1.0] — 2026-11-09

### Improved
- **Clickable Inline Jira & GitHub PR Links (`ui/app.js`, `ui/styles.css`):**
  - Every Jira ticket key (`PRD-XXXX`, `QA-XXXX`, `SUP-XXXX`) and GitHub PR (`repo#123`) cited inside **Bloc 1 (Pourquoi on en parle)** and **Bloc 2 (De quoi parler)** is now rendered as a clickable link (`<a class="inline-jira-link">` / `<a class="inline-pr-link">`).
- **Sole Team QA Rule (`Christel FOMBA` — `In QA` vs `Waiting for QA`):**
  - Stories/tickets in **`In QA`** for `< 2` workdays with no blocking issue mean **Christel** is actively testing them: they are automatically kept out of `🎯 Agenda du Jour` (`😌 R.A.S. / Autres`).
  - Stale `In QA` (`>= 2` workdays) and `Waiting for QA` items address **`Christel`** directly instead of the developer left in the Jira `assignee` field, and `In QA` items are attributed to **`Christel FOMBA (QA)`** in `👥 Vue par Membre`.
- **Single-Row Equal-Size Action Bar in Bloc 3 (`⚡ 3. Actions rapides en séance`):**
  - The 3 buttons are aligned on a single horizontal row (`flex-wrap: nowrap; flex: 1 1 0; min-height: 46px`) with **`↗ Ouvrir PRD-XXXX dans Jira`** first on the left, **`⚡ Passer PRD-XXXX en "..."`** in the middle, and **`✅ Sujet traité — Passer au suivant (Espace)`** on the right.

---

## [2.0.0] — 2026-11-09

### Changed & Improved
- **Conversational Daily Guide (`v2.0.0` — `ui/index.html`, `ui/styles.css`, `ui/app.js`):**
  - **Strict "Agenda du Jour" Filtering (`🎯 Agenda du Jour`):** Only displays Stories where **a ticket moved since the previous workday OR a ticket has been waiting too long / has a GitHub PR ↔ Jira drift**. Normal in-progress Stories without movement or alert, unstarted `À faire` Stories, and completed Stories are tucked into the secondary `😌 R.A.S. / Autres` tab.
  - **3 Plain-French Conversational Blocks per Story (`buildConversationalGuide`):**
    1. **📍 1. Pourquoi on en parle ce matin:** Plain-French summary of what moved yesterday and what is waiting or desynchronized today.
    2. **💬 2. De quoi parler avec l'équipe:** Ready-to-read questions addressed directly to the relevant teammates by first name (e.g., *"Demander à **Guillaume** : la PR `2cloud#27336` est approuvée depuis 3j, est-ce qu'on peut la merger aujourd'hui ?"*).
    3. **⚡ 3. Actions rapides en séance:** 1-click Jira status transition buttons, direct clickable PR pills, and a prominent **`✅ Sujet traité — Passer au suivant (Espace)`** button that marks the Story as reviewed and automatically advances to the next Agenda item.
  - **Collapsible Technical Drawer (`▶ Voir le détail technique`):** Keeps subtasks, PRs, and QA scenarios tucked inside a bottom drawer by default so the main screen stays ultra-clean during screen sharing.

---

## [1.4.0] — 2026-11-06

### Added & Improved
- **Deterministic Daily Order by "What the Story is Waiting For" (`computeWaitingDiagnosis` in `ui/app.js`):**
  - Every active Story is automatically diagnosed and ordered from `#1` to `#N` according to what it is waiting on right now:
    1. **🔴 1. Dev Terminé ➔ À passer en QA:** 100% of subtasks/PRs are merged/done, Story just needs to be transitioned to `Waiting for QA`.
    2. **🧪 2. En Attente de Recette QA:** Stories in `Waiting for QA` (waiting for QA pickup) or `In QA` (waiting for test validation).
    3. **🚀 3. PR Approuvée ➔ En Attente de Merge:** Stories with an open `APPROVED` PR (or `Waiting Merge` subtask) ready to merge today.
    4. **👀 4. PR Ouverte ➔ En Attente de Review:** Stories waiting on peer code review.
    5. **🔓 5. Débloquée ➔ En Attente de Relais (`BACK` / `FRONT`):** Stories where a prerequisite (`BACK` or `FRONT mocks`) finished and the next subtask is ready to be picked up.
    6. **🚧 6. En Cours de Développement:** Active dev in progress (oldest first).
  - **Unstarted Stories Kept in the Background (`💤 En retrait`):** Stories at `0%` (`À faire` with no started subtasks or PRs) and completed Stories (`Terminé(e)`) are automatically tucked away in a collapsed drawer at the bottom of the sidebar so they never clutter the Daily walkthrough.
  - Added a prominent **"Attend : ..."** diagnosis banner on each sidebar card and at the top of the Story Detail Sheet.

---

## [1.3.0] — 2026-11-06

### Changed & Improved
- **Story-by-Story Master-Detail UI (`ui/index.html`, `ui/styles.css`, `ui/app.js`):**
  - Replaced the dense multi-card grid with a clean, breathable **Master-Detail Split View** tailored for walking through the Daily **Story by Story**:
    - **Left Sidebar:** Lists all active Stories & tickets strictly ordered by **Workflow Status** (`🧪 1. En QA` $\rightarrow$ `👀 2. En Revue / Waiting Merge` $\rightarrow$ `🚧 3. En Cours de Dev` $\rightarrow$ `📋 4. À Faire` $\rightarrow$ `✅ 5. Terminées`), with keyboard navigation (`j` / `k`), `Space` completion checkmarks (`0/N vues`), and quick tabs (`Actives`, `Alertes`, `À faire`, `Terminées`, `Toutes`).
    - **Right Main Stage (`📌 Fiche Story Pas-à-pas`):** Displays **only the selected Story** in full clarity:
      1. **Story Hero Card:** Epic context, status badge, workday counter, assignee, full Story title, own PRs, and subtask completion progress bar.
      2. **⚡ Points d'attention & Actions sur cette Story:** Only shown if the Story or its subtasks have a GitHub PR ↔ Jira drift (with 1-click transition button) or a newly unblocked "Next Ticket" hand-off (`BACK` $\rightarrow$ `FRONT` / `Story` $\rightarrow$ `QA`).
      3. **📋 Sous-tâches ordonnées par statut:** Spacious 2-line task cards (`Waiting Merge` $\rightarrow$ `Revue` $\rightarrow$ `En cours` $\rightarrow$ `À faire` $\rightarrow$ `Terminé(e)`) with zero overlapping links/tags.
      4. **⛔ Dépendances Bloquantes, 🧪 Scénarios QA liés (`QA-*`), et 🌊 Mouvements 24h.**

---

## [1.2.0] — 2026-11-06

### Fixed & Improved
- **Zero Overlapping Links / Badges in Story & Task Rows (`ui/styles.css`, `ui/app.js`):**
  - Replaced single-line flex squeezing in `.child-row` with a clean **2-line vertical layout**: Line 1 displays the status icon, role badge, non-shrinking Jira key (`PRD-XXXX`), full readable task title, status badge, workday counter, and assignee; Line 2 displays the indented PR pills.
  - Added **Smart PR Pill Compaction**: when a task has multiple merged PRs (e.g., 5 merged PRs across microservices), only open PRs (or the latest merged PR) are shown inline, with a clickable `+N PRs mergées` toggle button to expand/collapse historical PRs.
- **External Linked Issue Resolution (`scripts/daily-engine.js`):**
  - Batch-fetches linked child/parent issues (`Parent-Child`, `Parent`, `Covering`) closed in prior sprints so their real Jira assignee is displayed instead of `External/Unassigned`.
- **Strict Workflow Status Ordering ("Walk the Board" — `IN_QA` $\rightarrow$ `IN_REVIEW` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `READY` $\rightarrow$ `DONE`):**
  - **View 2 (`🧩 Board Stories & Statuts`):** Groups all Stories and standalone tickets into 5 collapsible workflow status stages (`En QA`, `En Revue / Waiting Merge`, `En cours`, `À faire` collapsed by default, `Terminées` collapsed by default).
  - Automatically promotes Stories marked `À faire` that have active child tasks into their effective active stage (`En Revue` / `En cours` / `Prête pour QA`).
  - Sorts child tasks inside every Story by status rank (`Waiting Merge` $\rightarrow$ `Revue` $\rightarrow$ `En cours` $\rightarrow$ `À faire` $\rightarrow$ `Terminé(e)`).
  - Sub-groups Cockpit alerts by priority and status, and adds global **Status Filter Pills** in the navigation bar.

---

## [1.1.0] — 2026-11-06

### Added
- **Popcorn Daily Web Hub (`ui/server.mjs`, `ui/index.html`, `ui/styles.css`, `ui/app.js`):**
  - Clean, distraction-free Web interface running on `http://localhost:4343` designed to be screen-shared during the Daily Standup.
  - **4 Interactive Views (Keyboard shortcuts `1`–`4`):**
    1. **⚡ Flash Alertes & Déblocages (`1`):** 3-column cockpit displaying Next Ticket Unblocks (`BACK` $\rightarrow$ `FRONT`, `Story` $\rightarrow$ `QA`, `Blocks`), GitHub PR ↔ Jira Status Drifts with **1-click Jira status transition buttons**, and Stale WIP tickets.
    2. **👥 Mode Tour de Table (`2`):** Speaker-by-speaker facilitation view with `j`/`k` navigation, `Space` speaker completion checkmarks, member-specific alerts, recent transitions, active WIP cards, and next `À faire` items.
    3. **🧩 Avancement par Story (`3`):** Visual progress bars per Story/Feature (`BACK` / `FRONT` / `QA` test badges).
    4. **🌊 Mouvements 24h (`4`):** Chronological status transition timeline since the previous workday.
  - **Presentation Mode (`p`), Dark/Paper Theme Toggle (`t`), Live Jira+GitHub Sync (`r`), Role Filter Pills, and 1-Click Shareable `.zip` Export (`/api/export-zip`).**

---

## [1.0.0] — 2026-11-06

### Added
- **Initial Release (`v1.0.0`)** of the **Popcorn Daily Scrum Assistant** (`popcorn-daily`).
- **Jira Active Sprint Batch Analyzer (`scripts/daily-engine.js`):**
  - Automatic OAuth authentication via `acli` macOS Keychain (`ubitransport.atlassian.net` REST API v3).
  - Fetches all issues in the active sprint (`sprint in openSprints()`) for Team **Popcorn** (`b6f87d61-69e0-459b-ba68-a322281b9805`, Board `1314`) with full `changelog`, `issuelinks`, `parent`, and `subtasks` expansion.
  - Resolves external linked issues (`QA-*`, cross-sprint blockers, parent Stories/Epics) to build the complete dependency graph.
- **Workday-Aware Status Tracking & Stale Ticket Detection:**
  - Normalizes bilingual FR/EN Jira statuses (`À faire`/`To Do`, `En cours`/`In Progress`, `Revue en cours`/`In Code Review`/`Waiting Merge`, `Waiting for QA`/`In QA`, `Terminé(e)`/`Done`).
  - Computes elapsed **workdays** (excluding weekends and French public holidays) since the last status transition.
  - Differentiated stale thresholds: `>= 3` workdays in `En cours`, `>= 2` workdays in `Revue / Waiting Merge`, `>= 2` workdays in `Waiting for QA / In QA` (ignoring `Ready` / `À faire` / `Support Level 2`).
- **4-Rule Dependency & Unblocking Engine ("Next Ticket / Hand-off"):**
  1. **Explicit Blockers (`Blocks` / `Gantt End to Start`):** Highlights downstream tickets unblocked when a blocker reaches `Terminé(e)` or `Waiting for QA`.
  2. **Story Sibling Hand-off (`BACK` $\rightarrow$ `FRONT`):** When a `BACK` task under a Story finishes, automatically flags sibling `FRONT` tasks (especially API integration / non-mock tasks) that are now ready to start or complete.
  3. **Story Ready for QA (`BACK` + `FRONT` Complete):** Detects when 100% of technical child tasks (`Parent-Child`, `Parent`, `Covering`) of a Story are `Terminé(e)` while the parent Story is still in `En cours` / `Revue en cours`, listing associated `QA-*` test cases.
  4. **Soft Links (`Relates to`):** Flags active sprint tickets linked via `Relates` to newly completed tickets.
- **4-Rule GitHub PR ↔ Jira Status Drift Detector (`org:ubitransports`):**
  1. **All PRs Merged, Jira Not Updated:** All PRs referencing the ticket key are `MERGED` (0 open), yet Jira status is still `En cours`, `Revue en cours`, `In Code Review`, or `Waiting Merge`.
  2. **Open (Non-Draft) PR Waiting for Review, Jira Still in Dev/Todo:** Active PR is ready for review (`OPEN`, non-draft), yet Jira status is still `À faire` or `En cours`.
  3. **Approved or Changes Requested PR Stalled (> 24h):** PR is `APPROVED` (ticket not moved to `Waiting Merge` / merged) or has `CHANGES_REQUESTED` for $> 24\text{h}$ without update.
  4. **Ticket in Review Without Any GitHub PR:** Jira status is `Revue en cours`, `In Code Review`, or `Waiting Merge`, but no matching PR was found on GitHub.
- **Mixed-Format Daily Support Report & Snapshot Persistence:**
  - Generates dated Markdown reports in `~/.config/popcorn-daily/reports/YYYY-MM-DD.md` and JSON snapshots in `~/.config/popcorn-daily/snapshots/YYYY-MM-DD.json`.
  - Read-only by default with optional interactive `transition <KEY> "<STATUS>"` command for post-daily Jira status cleanup.
- **Shareable Packaging & Versioning (`scripts/package-zip.sh` & `install.sh`):**
  - One-command shareable `.zip` builder (`popcorn-daily.zip` & `popcorn-daily-v1.0.0.zip`) with automatic path sanitization and interactive team installer.
