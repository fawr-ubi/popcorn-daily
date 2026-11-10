# 🍿 Popcorn Daily — Guide d'Animation du Daily Standup

Outil visuel d'animation de Daily Standup pour l'équipe **Popcorn** (Jira Cloud `ubitransport.atlassian.net` + GitHub `ubitransports`).

Il croise automatiquement les tickets du sprint actif Jira et l'état réel des Pull Requests GitHub pour afficher **uniquement les Stories qui ont bougé la veille ou qui attendent une action**, avec pour chaque sujet :
1. **📍 Pourquoi on en parle ce matin** *(ce qui a bougé hier / ce qui bloque)*
2. **💬 De quoi parler avec l'équipe** *(la question prête à lire avec le prénom de la personne concernée, y compris la règle "1 seule QA : Christel")*
3. **⚡ Actions rapides en 1 clic** *(ouvrir Jira, changer le statut Jira en direct, cocher et passer au sujet suivant avec `Espace`)*

---

## 🚀 Installation Ultra-Simple (PO / Scrum Master — Sans compétence technique)

### Étape 1 — Installer l'application en 1 copier-coller (30 secondes)

Sur ton Mac :
1. Appuie sur **`Cmd + Espace`** (Spotlight), tape **`Terminal`** et appuie sur **Entrée**.
2. Copie-colle cette ligne puis appuie sur **Entrée** :

```bash
curl -fsSL https://raw.githubusercontent.com/fawr-ubi/popcorn-daily/main/setup-mac.sh | bash
```

**Ce que ça fait tout seul :**
- Télécharge automatiquement l'outil (et son moteur si besoin, sans aucun mot de passe administrateur).
- Crée une icône **`🍿 Popcorn Daily.command`** directement sur ton **Bureau (Desktop)**.
- Ouvre automatiquement le Guide d'Animation dans ton navigateur sur **[http://localhost:4343](http://localhost:4343)**.

---

### Étape 2 — Première ouverture (1 minute, dans le navigateur)

Lors du tout premier lancement, une fenêtre **⚙️ Configuration Rapide** s'affiche directement sur la page web :
1. Renseigne ton **adresse email Matawan / Ubitransport**.
2. Clique sur le bouton bleu **« ↗ Créer mon Token Jira en 2 clics »**, clique sur *Create API token*, et colle le code dans la case.
3. *(Optionnel, pour voir l'état des PRs)* Clique sur **« ↗ Créer mon Token GitHub pré-rempli »**, clique en bas sur le bouton vert *Generate token*, et colle le code `ghp_...`.
4. Clique sur **« 🚀 Enregistrer mes accès et lancer le Daily »** : c'est terminé pour toujours !

---

### ☀️ Utilisation tous les matins

1. **Double-clique sur l'icône `🍿 Popcorn Daily.command` sur ton Bureau** (ou ouvre **[http://localhost:4343](http://localhost:4343)**).
   - *Astuce : chaque fois que tu double-cliques sur l'icône, l'application récupère automatiquement les dernières améliorations publiées sur GitHub et synchronise le Daily du jour !*
2. Déroule les sujets de l'onglet **`🎯 Agenda du Jour`** un par un :
   - Appuie sur la barre **`Espace`** (ou clique sur **`✅ Sujet traité — Passer au suivant`**) pour passer d'une Story à la suivante.
   - Clique sur **`🔄 Sync`** en haut à droite si tu veux rafraîchir les données en direct pendant la réunion.

---

## 🛠️ Mode Développeur / Agent IA (Optionnel)

Si tu utilises déjà `acli` (`acli jira auth login`) et `gh` (`gh auth login`), aucune configuration manuelle n'est requise : l'outil détecte automatiquement ta session dans le trousseau macOS.

```bash
# Générer le rapport Markdown + Snapshot JSON du jour en CLI
node scripts/daily-engine.js report

# Lancer le serveur Web local sur http://localhost:4343
node ui/server.mjs
```
