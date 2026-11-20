![CI](https://github.com/PG56YAC/I324_S3_CI/actions/workflows/ci.yml/badge.svg?branch=ci/cedricjankiewicz)
# I324 – S3 – Intégration continue

Vous rejoignez l'équipe qui développe une petite application de liste de tâches. Le linter et les tests existent, un hook les lance avant chaque commit. Pourtant, hier, quelqu'un a poussé du code qui ne passait pas le linter, et personne ne l'a vu avant la mise en production.

Votre travail aujourd'hui : construire le **pipeline d'intégration continue** de l'équipe, une demande après l'autre. Personne ne vous dira comment écrire le YAML : chaque demande décrit un besoin, à vous de trouver comment y répondre.

Vous avancez seul, à votre rythme. Après chaque push, un **bot** lit votre workflow et le résultat de ses exécutions, puis vous répond par e-mail avec la demande suivante. Quand votre CI est rouge, il ne vous dit pas pourquoi : c'est à vous de lire le journal.

Dans tout le parcours, `<pseudo>` est votre nom d'utilisateur GitHub **en minuscules**.

## Avant de commencer

Si votre PC n'est pas encore prêt (Git, Node.js, identité Git, notifications), suivez d'abord [INSTALLATION.md](INSTALLATION.md).

## Mission 1 : rejoindre l'équipe

1. **Cloner** le dépôt dans VS Code (`Ctrl+Shift+P` › **Git: Clone**), avec l'adresse donnée par l'enseignant, puis ouvrir le dossier.
2. **Installer** les dépendances, dans le terminal :
   ```
   npm install
   ```
3. **Créer votre branche** `ci/<pseudo>` à partir de `origin/main` : en bas à gauche, cliquez sur le nom de la branche › **Create new branch from...** › `origin/main`.
4. **Explorer** le dossier `.github/workflows/` : il contient déjà deux workflows. L'un d'eux se lance tout seul, sans que personne ne pousse.
5. **Créer votre fichier de réponses** `reponses/<pseudo>.md`, avec ce contenu :
   ```
   # Réponses de <pseudo>

   q1: le nom du workflow qui se lance sans que personne ne pousse
   q2:
   q3:
   q4:
   q5:
   q6:
   q7:
   q8:
   q9:
   ```
   Remplacez le texte de `q1` par votre réponse. Les autres lignes se remplissent au fil des missions.
6. **Commit** avec le message `docs: ajoute ma fiche de réponses`, puis **pousser** : bouton **Publish Branch**.

Le bot vous répond quelques secondes plus tard, par e-mail.

## Règles du jeu

- Vous travaillez uniquement sur `ci/<pseudo>`. Les branches des autres ne vous concernent pas.
- Votre workflow s'appelle `CI` et se trouve dans `.github/workflows/ci.yml` : c'est la convention de l'équipe.
- Ne modifiez pas `bot.yml` ni `nettoyage.yml`.
- Chaque étape se termine par un commit et un push : sans push, le bot ne voit rien.
- Le bot répond quand votre CI est **terminée** : suivez-la dans l'onglet **Actions** du dépôt.
- Pas de réponse du bot deux minutes après la fin de votre CI ? Regardez l'onglet **Actions**, puis demandez à l'enseignant.

---

Application d'origine : [docker/getting-started-app](https://github.com/docker/getting-started-app), licence MIT.
