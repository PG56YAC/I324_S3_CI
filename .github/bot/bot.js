// Bot « Intégration continue » (I324, S3).
// Il lit le workflow écrit par l'élève (.github/workflows/ci.yml sur ci/<pseudo>)
// et le résultat réel de ses exécutions (API GitHub), puis répond par un commentaire de commit.
// Déclenché à la fin de chaque exécution du workflow « CI » (workflow_run), et à chaque push
// quand la CI ne peut pas répondre (pas encore de workflow, workflow mal nommé ou illisible,
// commit de documentation seule).
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');

const env = process.env;
const REPO = env.REPO;
const FICHIER_CI = '.github/workflows/ci.yml';

// ---------------------------------------------------------------------------------------------
// Outils : git, API GitHub (ou fichier de simulation pour les tests locaux)
// ---------------------------------------------------------------------------------------------
const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50e6 }).trim(); } catch { return null; } };
const lire = (ref, f) => git('show', `${ref}:${f}`);

const SIMULATION = env.SIMULATION ? JSON.parse(fs.readFileSync(env.SIMULATION, 'utf8')) : null;
async function api(chemin) {
    if (SIMULATION) {
        if (chemin.startsWith('runs')) return { workflow_runs: SIMULATION.runs || [] };
        const m = /^jobs\/(\d+)$/.exec(chemin);
        if (m) return { jobs: (SIMULATION.jobs || {})[m[1]] || [] };
        const a = /^artifacts\/(\d+)$/.exec(chemin);
        if (a) return { artifacts: (SIMULATION.artifacts || {})[a[1]] || [] };
        if (chemin === 'lts') return SIMULATION.lts || null;
        return null;
    }
    const urls = {
        runs: (b) => `https://api.github.com/repos/${REPO}/actions/runs?branch=${encodeURIComponent(b)}&per_page=100`,
    };
    let url;
    if (chemin.startsWith('runs:')) url = urls.runs(chemin.slice(5));
    else if (chemin.startsWith('jobs/')) url = `https://api.github.com/repos/${REPO}/actions/runs/${chemin.slice(5)}/jobs?per_page=100`;
    else if (chemin.startsWith('artifacts/')) url = `https://api.github.com/repos/${REPO}/actions/runs/${chemin.slice(10)}/artifacts?per_page=100`;
    else if (chemin === 'lts') url = 'https://nodejs.org/dist/index.json';
    const r = await fetch(url, { headers: chemin === 'lts' ? {} : { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`API ${r.status} sur ${url}`);
    return r.json();
}

// Les deux versions LTS de Node.js les plus récentes (majeures), depuis nodejs.org
async function dernieresLts() {
    try {
        const liste = await api('lts');
        const majeures = [];
        for (const v of liste || []) {
            if (!v.lts) continue;
            const maj = v.version.replace(/^v/, '').split('.')[0];
            if (!majeures.includes(maj)) majeures.push(maj);
            if (majeures.length === 2) break;
        }
        if (majeures.length === 2) return majeures;
    } catch { /* réseau indisponible : valeurs de secours */ }
    return ['26', '24'];
}

// ---------------------------------------------------------------------------------------------
// Réponses écrites dans reponses/<pseudo>.md
// ---------------------------------------------------------------------------------------------
const normaliser = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[`'"]/g, '').replace(/\s+/g, ' ').trim();
const empreinte = (t) => crypto.createHash('sha256').update(normaliser(t)).digest('hex');
const QUIZ = {
    q1: ['c0363aa5e2c3a3361b045da1b685bc298fb369890158b1ca353cdb070e4796b1'],
    q5: ['59830ebc3a4184110566bf1a290d08473dfdcbd492ce498b14cd1a5e2fa2e441'],
    q6: ['f0b0e6a9a69d1ca564ea6336188c9db2a2b2b8ef89cc03bbe0f295512eff7ac7'],
    q7: ['c00c922c92f827273a4050a74a5bd06f380f527c2a03242240442a4b21f4ca3c'],
    q8: ['51898b757c58a69050f750f3c3e1a7b653aff723de29f66c23b164b5ac1aee9b', 'de5c8bfd2e95aa63dc61ada2651a27d9363f1e7e8b9afe91550716268b69bb99'],
};
const quizJuste = (q, v) => !!v && QUIZ[q].includes(empreinte(v));

function lireReponses(texte) {
    if (texte === null) return null;
    const rep = {};
    for (const l of texte.split(/\r?\n/)) {
        const m = /^\s*[-*]?\s*\**(q[0-9]+)\**\s*:\s*(.*)$/i.exec(l);
        if (m) rep[m[1].toLowerCase()] = m[2].trim();
    }
    return rep;
}

// ---------------------------------------------------------------------------------------------
// Lecture du workflow
// ---------------------------------------------------------------------------------------------
function lireWorkflow(texte) {
    if (texte === null) return { absent: true };
    try {
        const w = yaml.load(texte);
        if (!w || typeof w !== 'object') return { erreur: 'le fichier est vide ou ne contient pas de clés YAML.' };
        return { w };
    } catch (e) {
        const ligne = e.mark ? ` (ligne ${e.mark.line + 1})` : '';
        return { erreur: `YAML illisible${ligne} : ${String(e.reason || e.message).split('\n')[0]}. Vérifiez l'indentation (espaces, jamais de tabulations) et les deux-points.` };
    }
}

// Normalise la clé on: (texte, liste ou objet) en objet { evenement: config }
function declencheurs(w) {
    const on = w.on;
    if (!on) return {};
    if (typeof on === 'string') return { [on]: {} };
    if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, {}]));
    return Object.fromEntries(Object.entries(on).map(([k, v]) => [k, v || {}]));
}
const jobs = (w) => (w && w.jobs && typeof w.jobs === 'object' ? w.jobs : {});
const etapes = (job) => (job && Array.isArray(job.steps) ? job.steps.filter((s) => s && typeof s === 'object') : []);
const commandes = (job) => etapes(job).map((s) => String(s.run || '')).join('\n');
const actions = (job) => etapes(job).map((s) => String(s.uses || ''));
const utilise = (job, action) => actions(job).some((u) => u.toLowerCase().startsWith(action + '@'));
const besoins = (job) => (!job || !job.needs ? [] : Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)]);
const lanceLint = (job) => /npm run lint|npx eslint|\beslint\b/.test(commandes(job));
const lanceTests = (job) => /npm (run )?test|npm t\b|npx jest|\bjest\b/.test(commandes(job));
const setupNode = (job) => etapes(job).find((s) => String(s.uses || '').toLowerCase().startsWith('actions/setup-node@'));

// Contrôles minimaux, pour répondre au push quand GitHub refuserait le workflow sans rien dire
function problemeStructure(w) {
    if (w.name !== 'CI') return 'Votre workflow doit s\'appeler exactement `CI` (ligne `name: CI` tout en haut) : c\'est la convention de l\'équipe, et c\'est à ce nom que je réagis.';
    if (Object.keys(declencheurs(w)).length === 0) return 'Il manque la clé `on:` : sans déclencheur, le workflow ne se lance jamais.';
    const js = Object.entries(jobs(w));
    if (js.length === 0) return 'Il manque la clé `jobs:` avec au moins un job.';
    for (const [id, j] of js) {
        if (!j || typeof j !== 'object') return `Le job \`${id}\` est vide.`;
        if (!j['runs-on']) return `Le job \`${id}\` n'a pas de \`runs-on:\` : GitHub ne sait pas sur quelle machine le lancer.`;
        if (etapes(j).length === 0) return `Le job \`${id}\` n'a pas d'étapes (\`steps:\`).`;
        for (const b of besoins(j)) if (!jobs(w)[b]) return `Le job \`${id}\` attend (\`needs\`) un job \`${b}\` qui n'existe pas.`;
    }
    return null;
}

// Un motif paths-ignore couvre-t-il un fichier Markdown à la racine (README.md) ?
function ignoreMarkdown(motifs) {
    const versRegex = (m) => new RegExp('^' + String(m).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(.*/)?') + '$');
    return (Array.isArray(motifs) ? motifs : motifs ? [motifs] : []).some((m) => versRegex(m).test('README.md'));
}

// Cache commun à toutes les évaluations d'une exécution : le jeton des workflows est limité
// à 1000 appels par heure et par dépôt, chaque job ou artefact n'est lu qu'une fois.
const cache = { jobs: {}, artifacts: {} };

// ---------------------------------------------------------------------------------------------
// Contexte d'évaluation d'un commit
// ---------------------------------------------------------------------------------------------
async function contexte({ pseudo, branche, sha, runs, coupure, lts }) {
    const visibles = runs.filter((r) => !coupure || r.created_at <= coupure);
    const termines = visibles.filter((r) => r.status === 'completed');
    const lu = lireWorkflow(lire(sha, FICHIER_CI));
    let pkg = null;
    try { pkg = JSON.parse(lire(sha, 'package.json') || 'null'); } catch { pkg = null; }
    const c = {
        pseudo, branche, sha, pkg, lts,
        w: lu.w || null, erreurYaml: lu.erreur || null, sansWorkflow: !!lu.absent,
        reponses: lireReponses(lire(sha, `reponses/${pseudo}.md`)),
        lireFichier: (f) => lire(sha, f),
        termines,
        toutesRuns: visibles,
        // L'exécution qui correspond à ce commit, sinon la dernière terminée de la branche
        runCourant: termines.find((r) => r.head_sha === sha) || null,
        derniereRun: termines[0] || null,
        jobsDe: async (id) => (cache.jobs[id] = cache.jobs[id] || (await api(`jobs/${id}`)).jobs || []),
        artefactsDe: async (id) => (cache.artifacts[id] = cache.artifacts[id] || (await api(`artifacts/${id}`)).artifacts || []),
        workflowDe: (s) => lireWorkflow(lire(s, FICHIER_CI)).w || null,
        depuisMain: git('merge-base', '--is-ancestor', 'origin/main', sha) !== null,
    };
    return c;
}

// ---------------------------------------------------------------------------------------------
// Les missions. Chacune peut avoir :
//   structure(w, c) : ce que le workflow doit contenir (lu sur le commit poussé)
//   execution(c, run) : contrôles sur une exécution verte dont le workflow remplit la structure
//   reponses(c, run) : contrôles des réponses écrites dans reponses/<pseudo>.md
//   verifier(c) : contrôle entièrement libre (remplace les trois précédents)
//   titre, consigne, bilan
// Une mission réussie le reste : une CI rouge plus tard ne fait pas reculer la progression.
// ---------------------------------------------------------------------------------------------
const OK = { ok: true };
const tousJobs = (w) => Object.values(jobs(w || {}));

const MISSIONS = [
    {
        titre: 'Rejoindre l\'équipe',
        consigne: () => ['Suivez la mission 1 du README.'],
        verifier: async (c) => {
            if (!c.depuisMain) return { ok: false, aide: 'Votre branche ne part pas de `main`. Recréez-la depuis `origin/main`.' };
            if (c.reponses === null) return { ok: false, aide: `Le fichier \`reponses/${c.pseudo}.md\` est introuvable sur votre branche.` };
            if (!c.reponses.q1) return { ok: false, aide: 'La ligne `q1:` est vide.' };
            if (!quizJuste('q1', c.reponses.q1)) return { ok: false, aide: '`q1` : ce n\'est pas ce workflow. Ouvrez chaque fichier de `.github/workflows/` et lisez la clé `on:`.' };
            return OK;
        },
        bilan: () => [
            'Le dossier `.github/workflows/` contient des fichiers YAML que GitHub lit tout seul. Chaque fichier est un **workflow** : la clé `on:` dit **quand** il se lance (un push, un horaire `cron`, un clic…), la clé `jobs:` dit **quoi** faire.',
            'Le workflow `Nettoyage` se lance tous les quarts d\'heure (`*/15 * * * *`) sans que personne ne pousse. Le workflow `Bot`, c\'est moi.',
        ],
    },
    {
        titre: 'Un premier pipeline',
        consigne: () => [
            '> « Chaque fois que quelqu\'un pousse, je veux qu\'une machine propre récupère le code et installe le projet **exactement** avec les versions de `package-lock.json`. Pas les dernières versions : celles du lock. »',
            '> — Léa, responsable technique',
            '',
            'Convention de l\'équipe : le workflow est dans `.github/workflows/ci.yml` et s\'appelle `CI` (`name: CI`).',
            'Le modèle de la fiche papier vous aide. Documentation : https://docs.github.com/fr/actions',
            'Poussez, puis suivez votre exécution dans l\'onglet **Actions** du dépôt. Je réponds quand elle est terminée.',
        ],
        structure: (w, c) => {
            if (!w) return { ok: false, aide: c && c.erreurYaml ? c.erreurYaml : `Je ne trouve pas \`${FICHIER_CI}\` sur votre branche.` };
            const p = problemeStructure(w);
            if (p) return { ok: false, aide: p };
            const tous = tousJobs(w);
            if (!('push' in declencheurs(w))) return { ok: false, aide: 'Léa veut que la CI se lance à chaque **push**. Regardez votre clé `on:`.' };
            if (!tous.some((j) => utilise(j, 'actions/checkout'))) return { ok: false, aide: 'La machine de GitHub démarre vide : sans l\'action `actions/checkout`, elle n\'a pas votre code.' };
            if (!tous.some((j) => utilise(j, 'actions/setup-node'))) return { ok: false, aide: 'Il faut Node.js sur la machine : cherchez l\'action officielle qui l\'installe.' };
            if (tous.some((j) => /npm install|npm i\b/.test(commandes(j)))) return { ok: false, aide: '`npm install` peut mettre à jour les versions et réécrire le lock. Léa veut **exactement** les versions de `package-lock.json` : quelle commande npm fait ça ?' };
            if (!tous.some((j) => /npm ci\b/.test(commandes(j)))) return { ok: false, aide: 'Le projet n\'est pas installé. Quelle commande npm installe exactement les versions du lock ?' };
            return OK;
        },
        bilan: () => [
            'Votre premier pipeline tourne. À chaque push, GitHub prête une machine virtuelle neuve (un **runner**, ici `ubuntu-latest`), y exécute vos **étapes** dans l\'ordre, puis la détruit.',
            '`npm ci` installe exactement ce qui est écrit dans `package-lock.json`, et refuse de continuer si le lock et `package.json` ne correspondent pas. Sur un serveur, on veut toujours le même résultat : jamais `npm install`.',
            'Ce n\'est pas encore de l\'intégration continue : la machine installe, mais ne vérifie rien.',
        ],
    },
    {
        titre: 'Le hook ne suffit pas',
        consigne: () => [
            '> « Hier, Kevin a poussé avec `git commit --no-verify` du code qui ne passait pas le linter, et personne ne l\'a vu. Je veux que le serveur vérifie lui-même le **lint** et les **tests** à chaque push. Et prouvez-moi que ça marche. »',
            '> — Léa',
            '',
            '1. Ajoutez au pipeline les mêmes contrôles que le hook, plus les tests. Les scripts existent déjà dans `package.json`.',
            '2. La preuve : ajoutez `var x = 1;` à la fin de `src/index.js`, puis commitez **en contournant le hook** :',
            '```',
            'git add .',
            'git commit --no-verify -m "chore: test de la CI"',
            'git push',
            '```',
            '3. Regardez la CI échouer dans l\'onglet **Actions**. Notez le nom exact de l\'étape en échec à la ligne `q2:` de votre fichier de réponses.',
            '4. Retirez la ligne fautive, commitez normalement et poussez.',
        ],
        verifier: async (c) => {
            const tous = tousJobs(c.w);
            if (!tous.some(lanceLint)) return { ok: false, aide: 'Je ne vois pas le linter dans votre pipeline. Quel script de `package.json` le lance ?' };
            if (!tous.some(lanceTests)) return { ok: false, aide: 'Je ne vois pas les tests dans votre pipeline.' };
            // Une exécution rouge à cause du lint, après l'ajout du lint au pipeline
            let etapeRouge = null;
            let runRouge = null;
            for (const r of c.termines.filter((x) => x.conclusion === 'failure').slice(0, 5)) {
                if (r.conclusion !== 'failure') continue;
                const w = c.workflowDe(r.head_sha);
                if (!w || !tousJobs(w).some(lanceLint)) continue;
                for (const j of await c.jobsDe(r.id)) {
                    const s = (j.steps || []).find((x) => x.conclusion === 'failure');
                    if (s && /lint|eslint/i.test(s.name)) { etapeRouge = s.name; runRouge = r; break; }
                }
                if (etapeRouge) break;
            }
            if (!etapeRouge) {
                if (c.runCourant && c.runCourant.conclusion === 'failure') return { ok: false, aide: 'Votre CI est rouge, mais pas à cause du linter. Ouvrez l\'onglet **Actions** et lisez l\'étape en échec.' };
                return { ok: false, aide: 'Le pipeline contrôle bien le lint et les tests. Il manque la preuve : poussez avec `--no-verify` un commit qui ne passe pas le linter (point 2 de la consigne).' };
            }
            const vert = c.termines.find((r) => r.conclusion === 'success' && r.created_at > runRouge.created_at && tousJobs(c.workflowDe(r.head_sha)).some(lanceLint));
            if (!vert) return { ok: false, aide: 'Bien : la CI a attrapé l\'erreur que le hook a laissé passer. Notez le nom de l\'étape en échec à la ligne `q2:`, corrigez et poussez.' };
            if (!c.reponses || !c.reponses.q2) return { ok: false, aide: 'La ligne `q2:` est vide : notez le nom exact de l\'étape qui a échoué, tel qu\'il apparaît dans l\'onglet **Actions**.' };
            if (normaliser(c.reponses.q2) !== normaliser(etapeRouge)) return { ok: false, aide: '`q2` : ce n\'est pas le nom exact de l\'étape en échec. Rouvrez l\'exécution rouge dans l\'onglet **Actions** et recopiez le nom affiché.' };
            return OK;
        },
        bilan: () => [
            'C\'est le cœur de l\'**intégration continue** : chaque push est vérifié par une machine neutre, avec les mêmes règles pour tout le monde. Le hook attrape l\'erreur tôt sur votre PC, la CI garantit que rien ne passe, même avec `--no-verify`.',
            'Quand une étape échoue, la suite du job n\'est pas exécutée et l\'exécution entière devient rouge. Sans nom (`name:`), une étape s\'affiche avec sa commande (`Run npm run lint`) : donnez des noms clairs, c\'est ce que lit celui qui cherche la panne.',
        ],
    },
    {
        titre: 'Deux jobs en parallèle',
        consigne: () => [
            '> « Quand le lint échoue, la CI s\'arrête et on ne sait jamais si les tests passent. Je veux voir **les deux résultats à chaque fois**, et le plus vite possible. »',
            '> — Léa',
            '',
            'Réorganisez votre pipeline. Quand c\'est vert, répondez à la ligne `q3:` : combien de machines (runners) votre exécution a-t-elle utilisées ?',
        ],
        structure: (w) => {
            const js = Object.entries(jobs(w || {}));
            const jl = js.filter(([, j]) => lanceLint(j)).map(([id]) => id);
            const jt = js.filter(([, j]) => lanceTests(j)).map(([id]) => id);
            if (jl.length === 0 || jt.length === 0) return { ok: false, aide: 'Le lint et les tests doivent rester dans le pipeline.' };
            if (!jl.some((a) => jt.some((b) => a !== b))) return { ok: false, aide: 'Le lint et les tests sont encore dans le même job : si le lint échoue, les tests ne tournent pas. Un job = une machine.' };
            const separes = jl.some((a) => jt.some((b) => a !== b && !besoins(jobs(w)[a]).includes(b) && !besoins(jobs(w)[b]).includes(a)));
            if (!separes) return { ok: false, aide: 'Vos deux jobs s\'attendent l\'un l\'autre (`needs`) : ils ne tournent pas en même temps, et si le premier échoue, le second est sauté.' };
            return OK;
        },
        reponses: async (c, candidats) => {
            if (!c.reponses || !c.reponses.q3) return { ok: false, aide: 'Pipeline correct. Il reste `q3:` : combien de machines votre exécution verte a-t-elle utilisées ? Regardez son schéma dans l\'onglet **Actions**.' };
            const n = parseInt(c.reponses.q3, 10);
            for (const r of candidats) if ((await c.jobsDe(r.id)).length === n) return OK;
            return { ok: false, aide: '`q3` : ce n\'est pas le bon nombre. Ouvrez votre dernière exécution verte et comptez les jobs du schéma.' };
        },
        bilan: () => [
            'Les jobs d\'un workflow tournent **en parallèle** par défaut, chacun sur sa propre machine. Un job rouge n\'empêche pas les autres de finir : on voit tous les problèmes d\'un coup.',
            'Chaque job repart d\'une machine vide : il faut refaire `checkout`, `setup-node` et `npm ci` dans chacun. C\'est le prix de l\'isolation.',
        ],
    },
    {
        titre: 'Le paquet pour le testeur',
        consigne: () => [
            '> « Je veux télécharger l\'application prête à installer, sans cloner le dépôt ni rien installer. Mais **seulement si le lint et les tests sont passés** : je ne teste pas une version cassée. »',
            '> — Marco, testeur',
            '',
            'La commande `npm pack` fabrique un paquet installable (`.tgz`) à partir du projet. Ce fichier doit être téléchargeable depuis la page de l\'exécution : on appelle ça un **artefact**.',
            'Quand c\'est vert, téléchargez l\'artefact depuis la page de l\'exécution et répondez à la ligne `q4:` : quel est le nom exact du fichier qu\'il contient ?',
        ],
        structure: (w) => {
            const js = jobs(w || {});
            const ids = Object.keys(js);
            const jl = ids.filter((id) => lanceLint(js[id]));
            const jt = ids.filter((id) => lanceTests(js[id]));
            const jp = ids.find((id) => /npm pack/.test(commandes(js[id])));
            if (!jp) return { ok: false, aide: 'Aucune étape ne fabrique le paquet (`npm pack`).' };
            if (!utilise(js[jp], 'actions/upload-artifact')) return { ok: false, aide: 'Le paquet est fabriqué, puis disparaît avec la machine. Cherchez l\'action officielle qui envoie un fichier comme artefact.' };
            const att = besoins(js[jp]);
            if (!jl.some((x) => att.includes(x)) || !jt.some((x) => att.includes(x))) return { ok: false, aide: 'Marco ne veut le paquet que si le lint **et** les tests sont passés : le job du paquet doit attendre les deux.' };
            return OK;
        },
        execution: async (c, run) => ((await c.artefactsDe(run.id)).length > 0 ? OK
            : { ok: false, aide: 'Votre exécution verte n\'a produit aucun artefact. Regardez l\'étape d\'envoi dans l\'onglet **Actions** : quel chemin lui avez-vous donné ?' }),
        reponses: async (c) => {
            const attendu = c.pkg ? `${c.pkg.name}-${c.pkg.version}.tgz` : '';
            if (!c.reponses || !c.reponses.q4) return { ok: false, aide: 'L\'artefact existe. Il reste `q4:` : téléchargez-le depuis la page de l\'exécution et notez le nom du fichier qu\'il contient.' };
            if (normaliser(c.reponses.q4) !== normaliser(attendu)) return { ok: false, aide: '`q4` : ce n\'est pas le nom du fichier contenu dans l\'artefact. Téléchargez-le et ouvrez le zip.' };
            return OK;
        },
        bilan: () => [
            'Un **artefact**, c\'est un fichier produit par le pipeline et conservé après la destruction de la machine : un paquet, un exécutable, un rapport. Il ne va jamais dans le dépôt Git : le dépôt contient le code source, les artefacts sont **construits** à partir de lui.',
            '`needs:` crée un ordre entre les jobs : le paquet n\'est fabriqué que si le lint et les tests sont verts. Si l\'un échoue, le job du paquet est sauté (gris).',
            'En entreprise, ces paquets partent ensuite dans un **registre** (npm, GitHub Packages, Nexus…) d\'où on les installe en production.',
        ],
    },
    {
        titre: 'Enquête : la CI de la nuit',
        consigne: () => [
            '> « Cette nuit, la CI de la branche `exemple/rouge` a échoué. Je n\'ai pas le temps de regarder : trouvez-moi ce qui s\'est passé. »',
            '> — Léa',
            '',
            'Dans l\'onglet **Actions**, filtrez sur la branche `exemple/rouge`, ouvrez l\'exécution rouge et lisez le journal. Répondez dans votre fichier :',
            '```',
            'q5: le nom du job en échec',
            'q6: le nom de l\'étape en échec',
            'q7: le nom du test qui échoue',
            'q8: le fichier du code source qui contient le problème',
            '```',
            'Pour `q8`, le journal ne suffit pas : regardez aussi ce que le dernier commit de `exemple/rouge` a modifié.',
        ],
        verifier: async (c) => {
            const r = c.reponses || {};
            for (const q of ['q5', 'q6', 'q7', 'q8']) if (!r[q]) return { ok: false, aide: `La ligne \`${q}:\` est vide.` };
            if (!quizJuste('q5', r.q5)) return { ok: false, aide: '`q5` : ce n\'est pas le job en échec. Dans le schéma de l\'exécution, le job rouge porte une croix.' };
            if (!quizJuste('q6', r.q6)) return { ok: false, aide: '`q6` : ouvrez le job rouge, l\'étape en échec est marquée d\'une croix. Recopiez son nom exact.' };
            if (!quizJuste('q7', r.q7)) return { ok: false, aide: '`q7` : dans le journal de l\'étape, cherchez la ligne qui commence par `●` : c\'est le nom du test.' };
            if (!quizJuste('q8', r.q8)) return { ok: false, aide: '`q8` : le test n\'est pas le coupable, il signale le problème. Quel fichier de `src/` le dernier commit de `exemple/rouge` a-t-il modifié ?' };
            return OK;
        },
        bilan: () => [
            'Lire un journal de CI, c\'est le quotidien : schéma de l\'exécution → job rouge → étape rouge → message d\'erreur. Le test qui échoue n\'est presque jamais le coupable : il **signale** qu\'un changement a cassé un comportement attendu.',
            'Ici, quelqu\'un a abaissé la longueur maximale d\'un nom de tâche dans `src/validation.js`. Le test a refusé, la CI est devenue rouge, et rien n\'est parti chez les clients.',
        ],
    },
    {
        titre: 'Les versions de nos clients',
        consigne: () => [
            '> « Nos clients installent l\'application sur **les deux versions LTS les plus récentes** de Node.js. Les tests doivent passer sur les deux. »',
            '> — Léa',
            '',
            'Trouvez ces deux versions sur https://nodejs.org/fr/about/previous-releases, puis faites tourner vos tests sur chacune, **sans copier-coller le job**.',
        ],
        structure: (w, c) => {
            const jt = Object.entries(jobs(w || {})).find(([, j]) => lanceTests(j));
            if (!jt) return { ok: false, aide: 'Les tests doivent rester dans le pipeline.' };
            const [, job] = jt;
            const matrice = job.strategy && job.strategy.matrix;
            if (!matrice || typeof matrice !== 'object') return { ok: false, aide: 'Un seul job de tests ne tourne que sur une version. Cherchez comment GitHub Actions lance le même job plusieurs fois avec des valeurs différentes (une **matrice**).' };
            const valeurs = Object.values(matrice).filter(Array.isArray).flat().map((v) => String(v).replace(/^v/, '').split('.')[0]);
            if (c.lts.some((m) => !valeurs.includes(m))) return { ok: false, aide: 'Ce ne sont pas les deux versions LTS les plus récentes. Regardez la colonne **LTS** de la page des versions de Node.js.' };
            const sn = setupNode(job);
            if (!sn || !/\$\{\{\s*matrix\./.test(String((sn.with || {})['node-version'] || ''))) return { ok: false, aide: 'La matrice existe, mais `setup-node` installe toujours la même version. Utilisez la valeur de la matrice dans `node-version`.' };
            return OK;
        },
        execution: async (c, run) => {
            const noms = (await c.jobsDe(run.id)).map((j) => j.name).join(' ');
            return c.lts.every((m) => noms.includes(m)) ? OK : { ok: false, aide: 'Votre exécution verte ne montre pas un job de tests par version. Vérifiez le schéma dans l\'onglet **Actions**.' };
        },
        bilan: (c) => [
            `Une **matrice** lance le même job plusieurs fois, une fois par valeur (ici Node.js ${c.lts.join(' et ')}). On teste toutes les versions de nos clients sans dupliquer le YAML.`,
            'Les versions **LTS** (Long Term Support) sont maintenues pendant des années : ce sont celles qu\'on installe en production. Les versions impaires ne le sont jamais.',
        ],
    },
    {
        titre: 'Un pipeline plus rapide',
        consigne: () => [
            '> « Le pipeline retélécharge toutes les dépendances à chaque exécution. Ça prend du temps, et les minutes de CI se paient. Gardez les dépendances d\'une exécution à l\'autre. »',
            '> — Léa',
            '',
            'Poussez **deux fois** après votre modification : la première exécution remplit le cache, la deuxième l\'utilise.',
            'Dans le journal de la deuxième exécution, ouvrez l\'étape `setup-node` et recopiez à la ligne `q9:` la phrase qui parle du cache.',
        ],
        structure: (w) => (tousJobs(w).some((j) => { const s = setupNode(j); return (s && /npm/.test(String((s.with || {}).cache || ''))) || utilise(j, 'actions/cache'); })
            ? OK : { ok: false, aide: 'Pas de cache dans votre pipeline. Regardez les options de l\'action `setup-node` : https://github.com/actions/setup-node' }),
        reponses: async (c, candidats) => {
            if (candidats.length < 2) return { ok: false, aide: 'Le cache est configuré. Il faut deux exécutions vertes avec cache : la première le remplit, la deuxième l\'utilise. Poussez encore une fois.' };
            if (!c.reponses || !c.reponses.q9) return { ok: false, aide: 'La ligne `q9:` est vide.' };
            if (!/restor|hit/i.test(c.reponses.q9)) return { ok: false, aide: '`q9` : ce n\'est pas la phrase du cache. Ouvrez l\'étape `setup-node` de la **deuxième** exécution.' };
            return OK;
        },
        bilan: () => [
            'Le **cache** garde des fichiers d\'une exécution à l\'autre, repérés par une clé calculée à partir de `package-lock.json`. Tant que le lock ne change pas, les paquets sont récupérés au lieu d\'être retéléchargés. Si le lock change, la clé change et le cache est reconstruit.',
            'Attention à ne pas confondre : le **cache** sert à accélérer, l\'**artefact** sert à livrer un résultat.',
        ],
    },
    {
        titre: 'Pas de CI pour la documentation',
        consigne: () => [
            '> « Quand on corrige juste une faute dans la documentation, la CI tourne pour rien. Et parfois, je veux pouvoir la relancer à la main, sans rien pousser. »',
            '> — Léa',
            '',
            'Modifiez les déclencheurs de votre workflow et poussez. Puis prouvez que ça marche : faites un commit qui ne modifie **qu\'un fichier `.md`**, et poussez-le seul. Aucune exécution ne doit apparaître dans l\'onglet **Actions**.',
        ],
        verifier: async (c) => {
            const d = declencheurs(c.w || {});
            if (!('workflow_dispatch' in d)) return { ok: false, aide: 'Léa veut aussi pouvoir lancer la CI à la main : il manque un déclencheur.' };
            if (!d.push || !ignoreMarkdown(d.push['paths-ignore'])) return { ok: false, aide: 'Le déclencheur `push` doit ignorer les fichiers Markdown. Cherchez l\'option de filtre par chemin de `on.push`.' };
            // Preuve : un commit de la branche qui ne touche que des .md, sans exécution
            const liste = git('log', '--format=@%H', '--name-only', `origin/main..${c.sha}`) || '';
            const avecRun = new Set(c.toutesRuns.map((r) => r.head_sha));
            let preuve = false;
            for (const bloc of liste.split('@').filter(Boolean)) {
                const [h, ...fichiers] = bloc.trim().split('\n').filter(Boolean);
                if (fichiers.length && fichiers.every((f) => f.endsWith('.md')) && !avecRun.has(h)) {
                    const w = c.workflowDe(h);
                    const dd = w ? declencheurs(w) : {};
                    if (dd.push && ignoreMarkdown(dd.push['paths-ignore'])) { preuve = true; break; }
                }
            }
            if (!preuve) return { ok: false, aide: 'Les déclencheurs sont corrects. Il manque la preuve : un commit qui ne modifie que des fichiers `.md`, poussé seul.' };
            return OK;
        },
        bilan: () => [
            '`paths-ignore` filtre les push selon les fichiers modifiés : un commit qui ne touche que la documentation ne lance plus rien. `workflow_dispatch` ajoute le bouton **Run workflow** dans l\'onglet Actions (il n\'apparaît que pour les workflows présents sur la branche principale).',
            'D\'autres déclencheurs existent : `pull_request` (avant une fusion), `schedule` (horaire, comme `Nettoyage`), `release`…',
        ],
    },
    {
        titre: 'Le badge',
        consigne: () => [
            '> « Je veux voir d\'un coup d\'œil, depuis le README de votre branche, si **votre** branche est verte. »',
            '> — Léa',
            '',
            'GitHub fournit une petite image qui affiche l\'état d\'un workflow. Ajoutez-la en haut du `README.md` de votre branche.',
        ],
        verifier: async (c) => {
            const r = c.lireFichier('README.md') || '';
            if (!/actions\/workflows\/ci\.ya?ml\/badge\.svg/.test(r)) return { ok: false, aide: 'Je ne trouve pas le badge de votre workflow dans `README.md`. Dans l\'onglet **Actions**, ouvrez le workflow `CI` : le menu `···` en haut à droite propose de créer un badge.' };
            if (!r.includes(`branch=${c.branche}`) && !r.includes(`branch=${encodeURIComponent(c.branche)}`)) return { ok: false, aide: 'Le badge affiche l\'état de `main`, pas celui de votre branche. Il accepte un paramètre pour choisir la branche.' };
            return OK;
        },
        bilan: () => [
            'Le badge est une image servie par GitHub, mise à jour à chaque exécution. On le met en tête des README pour que tout le monde voie l\'état de la branche principale sans ouvrir l\'onglet Actions.',
            'Vous avez terminé les missions obligatoires. Les deux suivantes sont des bonus.',
        ],
    },
    {
        titre: 'Bonus : couverture exigée',
        consigne: () => [
            '> « Je veux que **tout** le code de `src/routes/` soit couvert par les tests : 100 % des lignes et 100 % des branches. Et je veux que la CI refuse le contraire. »',
            '> — Sofia, responsable qualité',
            '',
            'Lancez `npx jest --coverage` sur votre PC pour voir où vous en êtes. Jest sait refuser une couverture trop faible : https://jestjs.io/fr/docs/configuration',
        ],
        structure: (w, c, sha) => {
            const s = sha || c.sha;
            let p = null;
            try { p = JSON.parse(lire(s, 'package.json') || 'null'); } catch { p = null; }
            const cfg = JSON.stringify((p && p.jest) || {}) + (lire(s, 'jest.config.js') || '') + (lire(s, 'jest.config.mjs') || '');
            if (!/coverageThreshold/.test(cfg)) return { ok: false, aide: 'Je ne trouve pas de seuil de couverture dans la configuration de Jest.' };
            if (!/src\/routes/.test(cfg)) return { ok: false, aide: 'Le seuil doit porter sur `src/routes/`, pas sur tout le projet.' };
            const couverture = tousJobs(w).some((j) => /--coverage/.test(commandes(j))) || /collectCoverage"?\s*:\s*true/.test(cfg);
            if (!couverture) return { ok: false, aide: 'Le seuil existe, mais la CI ne mesure pas la couverture : les tests doivent tourner avec la couverture activée.' };
            return OK;
        },
        bilan: () => [
            'La **couverture** mesure les lignes et les branches (chaque `if`, chaque `else`) exécutées par les tests. Avec un seuil, la CI devient rouge si quelqu\'un ajoute du code sans le tester.',
            '100 % de couverture ne veut pas dire zéro bug : un test peut passer partout sans rien vérifier d\'utile. C\'est un garde-fou, pas une preuve.',
        ],
    },
    {
        titre: 'Bonus : le rapport pour la qualité',
        consigne: () => [
            '> « Je veux lire le rapport de couverture sans lancer les tests moi-même, et voir un résumé directement sur la page de l\'exécution. »',
            '> — Sofia',
            '',
            'Attention : avec la matrice, plusieurs jobs produisent un rapport. Deux artefacts ne peuvent pas porter le même nom.',
        ],
        structure: (w) => {
            const envoi = tousJobs(w).some((j) => etapes(j).some((s) => String(s.uses || '').startsWith('actions/upload-artifact@') && /coverage/.test(JSON.stringify(s.with || {}))));
            if (!envoi) return { ok: false, aide: 'Le dossier `coverage/` n\'est envoyé comme artefact par aucune étape.' };
            if (!tousJobs(w).some((j) => /GITHUB_STEP_SUMMARY/.test(commandes(j)))) return { ok: false, aide: 'Il manque le résumé sur la page de l\'exécution. Cherchez « job summary » dans la documentation de GitHub Actions.' };
            return OK;
        },
        execution: async (c, run) => ((await c.artefactsDe(run.id)).some((a) => /cov|couv/i.test(a.name)) ? OK
            : { ok: false, aide: 'Aucun artefact de couverture dans votre exécution verte. Regardez l\'étape d\'envoi dans l\'onglet **Actions**.' }),
        bilan: () => [
            'Un pipeline ne sert pas qu\'aux développeurs : il produit des informations pour d\'autres métiers (qualité, test, exploitation). Le résumé (`$GITHUB_STEP_SUMMARY`) s\'affiche en Markdown sur la page de l\'exécution.',
        ],
    },
];

// Vérifie une mission. Pour une mission à structure : le workflow du commit doit la remplir,
// et une exécution verte dont le workflow la remplit aussi doit exister.
async function verifierMission(m, c) {
    if (m.verifier) return m.verifier(c);
    const s = m.structure(c.w, c);
    if (!s.ok) return s;
    const candidats = c.termines.filter((r) => r.conclusion === 'success' && m.structure(c.workflowDe(r.head_sha), c, r.head_sha).ok);
    if (candidats.length === 0) {
        if (c.runCourant && c.runCourant.conclusion !== 'success') return { ok: false, aide: 'Votre CI est rouge. Ouvrez l\'onglet **Actions**, cliquez sur la dernière exécution et lisez l\'étape en échec.' };
        return { ok: false, aide: 'Votre workflow est prêt, mais je n\'ai encore vu aucune exécution verte avec cette version. Poussez et suivez-la dans l\'onglet **Actions**.' };
    }
    if (m.execution) {
        let r = null;
        for (const run of candidats) { r = await m.execution(c, run); if (r.ok) break; }
        if (!r.ok) return r;
    }
    return m.reponses ? m.reponses(c, candidats) : OK;
}

// Évalue les missions dans l'ordre et s'arrête à la première ratée
async function evaluer(c) {
    let reussies = 0;
    let aide = '';
    for (const m of MISSIONS) {
        const r = await verifierMission(m, c);
        if (!r.ok) { aide = r.aide || ''; break; }
        reussies++;
    }
    return { reussies, aide };
}

// ---------------------------------------------------------------------------------------------
// Programme principal
// ---------------------------------------------------------------------------------------------
async function main() {
    const res = { commentaire: '', sha: env.SHA };
    const fin = () => { fs.writeFileSync(env.SORTIE, JSON.stringify(res)); if (env.AFFICHER) console.log(res.commentaire || '(pas de réponse)'); };
    const acteur = env.ACTEUR;
    const pseudo = acteur.toLowerCase();
    const branche = env.BRANCHE;
    const sha = env.SHA;
    const L = [`@${acteur}`, ''];

    if (branche !== `ci/${pseudo}`) {
        if (env.EVENEMENT === 'push') {
            L.push(`La branche \`${branche}\` ne correspond à rien ici : je ne regarde que \`ci/${pseudo}\` (pseudo en minuscules). Renommez-la ou recréez-la depuis \`origin/main\`.`);
            res.commentaire = L.join('\n');
        }
        return fin();
    }

    // Au push, je ne réponds que si la CI ne le fera pas
    if (env.EVENEMENT === 'push') {
        const lu = lireWorkflow(lire(sha, FICHIER_CI));
        if (!lu.absent) {
            const probleme = lu.erreur || problemeStructure(lu.w);
            const fichiers = (git('diff', '--name-only', env.AVANT && !/^0+$/.test(env.AVANT) ? `${env.AVANT}..${sha}` : `origin/main..${sha}`) || '').split('\n').filter(Boolean);
            const docSeule = fichiers.length > 0 && fichiers.every((f) => f.endsWith('.md'));
            const ignore = lu.w && declencheurs(lu.w).push && ignoreMarkdown(declencheurs(lu.w).push['paths-ignore']);
            if (probleme) {
                L.push('### Votre workflow ne peut pas démarrer', '', `> ${probleme}`, '');
                res.commentaire = L.join('\n');
                return fin();
            }
            if (!(docSeule && ignore)) return fin(); // la CI va tourner, je répondrai à la fin
        } else {
            const autres = (git('ls-tree', '--name-only', `${sha}`, '.github/workflows/') || '').split('\n').filter((f) => f && !/(bot|nettoyage)\.yml$/.test(f));
            if (autres.length) {
                L.push('### Votre workflow ne peut pas démarrer', '', `> J'ai trouvé \`${autres.join('`, `')}\`, mais la convention de l'équipe est \`${FICHIER_CI}\`. Renommez le fichier.`, '');
                res.commentaire = L.join('\n');
                return fin();
            }
        }
    }

    const runs = ((await api(`runs:${branche}`)).workflow_runs || [])
        .filter((r) => r.path === FICHIER_CI || r.name === 'CI')
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    const lts = await dernieresLts();

    // État après ce commit, et état juste avant (pour savoir ce qui vient d'être réussi)
    const courant = runs.find((r) => String(r.id) === String(env.RUN_ID));
    const coupure = courant ? courant.created_at : null;
    const c = await contexte({ pseudo, branche, sha, runs, coupure, lts });
    const apres = await evaluer(c);

    let avantEtat = 0;
    const precedent = courant ? runs.find((r) => r.created_at < courant.created_at && r.status === 'completed') : null;
    let shaAvant = precedent ? precedent.head_sha : (env.AVANT && !/^0+$/.test(env.AVANT) ? env.AVANT : null);
    if (!shaAvant) shaAvant = git('rev-parse', '--verify', '--quiet', `${sha}^`);
    if (shaAvant && git('cat-file', '-e', shaAvant) !== null) {
        const coupureAvant = precedent ? precedent.created_at : (courant ? '0' : null);
        const cAvant = await contexte({ pseudo, branche, sha: shaAvant, runs, coupure: coupureAvant, lts });
        avantEtat = (await evaluer(cAvant)).reussies;
    }
    // Un commit sans exécution (documentation seule) peut s'intercaler : on regarde aussi le parent
    const parent = git('rev-parse', '--verify', '--quiet', `${sha}^`);
    if (courant && parent && parent !== shaAvant) {
        const cParent = await contexte({ pseudo, branche, sha: parent, runs, coupure: precedent ? precedent.created_at : '0', lts });
        avantEtat = Math.max(avantEtat, (await evaluer(cParent)).reussies);
    }

    const n = MISSIONS.length;
    L.push(`**Progression : ${apres.reussies} sur ${n}**`, '');
    if (apres.reussies > avantEtat) {
        for (let i = avantEtat; i < apres.reussies; i++) {
            L.push(`### Mission ${i + 1} réussie : ${MISSIONS[i].titre}`, '', ...MISSIONS[i].bilan(c).flatMap((x) => [x, '']));
        }
        if (apres.reussies === n) {
            L.push('### Terminé', '', 'Toutes les missions sont réussies, bonus compris. Montrez ce message à votre enseignant.');
        } else {
            const m = MISSIONS[apres.reussies];
            L.push(`### Mission ${apres.reussies + 1} : ${m.titre}`, '', ...m.consigne(c), '');
        }
    } else if (apres.reussies === n) {
        L.push('Toutes les missions sont déjà réussies. Rien de nouveau à vérifier.');
    } else {
        const m = MISSIONS[apres.reussies];
        L.push(`### Mission ${apres.reussies + 1} : pas encore`, '', `> ${apres.aide}`, '',
            '<details><summary>Rappel de la consigne</summary>', '', ...m.consigne(c), '', '</details>', '');
    }
    if (apres.reussies < n) L.push('_Chaque étape se termine par un commit et un push : sans push, je ne vois rien._');
    res.commentaire = L.join('\n');
    return fin();
}

main().catch((e) => {
    console.error(e);
    fs.writeFileSync(env.SORTIE, JSON.stringify({ commentaire: '', sha: env.SHA }));
    process.exit(1);
});
