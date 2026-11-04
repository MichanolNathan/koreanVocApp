# MyFlashcardApp

Application personnelle de révision du coréen (coréen → français) : dictionnaire personnel, quiz de mots et de phrases, suivi indépendant de la maîtrise (signification par signification, phrase par phrase), et quiz ciblés sur les lacunes.

Cadrage fonctionnel : [`docs/PRD.md`](docs/PRD.md) (V1) et [`docs/PRD_iteration_2_traduction_phrases_v0.2.txt`](docs/PRD_iteration_2_traduction_phrases_v0.2.txt) (itération 2 — traduction de phrases).

## Fonctionnalités

* **Dictionnaire personnel** : mots coréens avec romanisation et une ou plusieurs **significations** (traduction, indice, contexte, exemples), chacune avec sa **catégorie grammaticale** — un même mot peut ainsi avoir un sens verbal et un sens nominal.
* **Recherche dans le dictionnaire** : saisie en coréen (사과), en français (pomme) ou en romanisation (sagwa) — insensible à la casse, aux accents et à la composition coréenne (jamo/syllabes), combinable avec le filtre par dictionnaire.
- **Dictionnaire officiel intégré** : 44 mots et expressions débutant livrés avec l'application (issus d'un deck Anki, traduits en français), disponibles dès l'installation et enrichis par les mises à jour. Les éditions et suppressions de l'utilisateur priment : le chargeur n'insère que des mots jamais livrés (registre interne `shipped_words`).
- **Quiz de vocabulaire** : 15 questions (ou moins si le dictionnaire est petit), une réponse par question, indice sur demande, validation stricte normalisée côté serveur (casse, accents, articles, pluriel ; une traduction d'une *autre* signification du mot reste correcte).
- **Quiz de phrases** (itération 2) : traduction de phrases coréennes débutantes (repère A1) issues d'une **bibliothèque de 80 phrases intégrée** — 7 thèmes du quotidien, aucune connexion nécessaire, aucune édition manuelle. Indice par phrase, traductions alternatives acceptées.
- **Quiz mixte** : 15 questions — exactement 8 de vocabulaire et 7 de phrases, ordre mélangé — avec résultats ventilés par catégorie.
- **Cacher la romanisation** (option de quiz) : préférence mémorisée dans le navigateur — la romanisation est masquée sous le mot ou la phrase, révélable par un bouton comme un indice (sans impact sur la maîtrise), et affichée automatiquement dans le corrigé.
- **Maîtrise EWMA** (λ = 0,6 sur les 10 dernières tentatives — sans indice 1,0 · avec 0,6 · échec 0) par signification **et** par phrase, indépendamment l'une de l'autre : rater une phrase ne dégrade pas les mots qu'elle contient. Niveaux : Maîtrisé / À renforcer / Non maîtrisé / Non évalué ; une erreur isolée ne dégrade pas.
- **Analyse et quiz ciblés** : points faibles (mots et phrases), dépendance aux indices, contextes problématiques ; modes Standard (pondéré par faiblesse), Non maîtrisées, À renforcer, Priorité faibles (70/30), Par contexte (thème pour les phrases). Chaque quiz peut cibler un dictionnaire : Personnel, Officiel ou tous.
- **Historique** des sessions avec résultats détaillés (type de quiz, détail par question, autres traductions acceptées).

## Branches & workflow de release

- `develop` — branche de développement courant : tout le travail part d'ici.
- `test` — couloir de validation des images Docker : merger `develop` dans `test`
  (puis pousser) déclenche *test-images-docker*
  ([`.github/workflows/docker-test.yml`](.github/workflows/docker-test.yml)) :
  build des deux images (`Dockerfile.db` puis `Dockerfile`) et smoke test du
  conteneur ([`scripts/docker-smoke.sh`](scripts/docker-smoke.sh) : démarrage,
  initialisation de la base dans le volume, client statique, lecture/écriture API,
  validation d'entrée, persistance après redémarrage).
- `main` — production, protégée : PR obligatoire, check *release-gate* requis,
  pas de push direct.

Cycle de release :

1. Merger `develop` dans `test` et pousser → la CI de test doit être verte.
2. Ouvrir la PR `develop` → `main`, accompagnée d'un tag `vX.Y.Z`. Le workflow
   *release-gate* ([`.github/workflows/release-gate.yml`](.github/workflows/release-gate.yml))
   rend la PR non mergeable tant que le code de la PR n'est pas sur `test` avec
   une CI de test réussie (il attend la fin d'un run en cours).
3. Merger la PR → *release-build*
   ([`.github/workflows/release-build.yml`](.github/workflows/release-build.yml))
   build les images, rejoue le smoke test puis publie sur GHCR : `:latest` à la
   fusion, `:X.Y.Z` au push du tag `vX.Y.Z`.


## Architecture

- `server/` — Node + TypeScript + Express. SQLite via **sql.js** (WASM, zéro module natif : aucune chaîne de compilation nécessaire). La base tient en mémoire et est persistée dans un fichier unique à chaque écriture. Validation des réponses exclusivement côté serveur (les traductions attendues ne quittent jamais le serveur avant la réponse). Modules : `db` (schéma + migrations), `phrase-library` (bibliothèque de phrases) et `official-dictionary` (dictionnaire officiel), tous deux chargés au démarrage, `mastery` (EWMA), `engine` (sélection + validation), `repo` + `routes` (API).
- `web/` — SPA React + TypeScript (Vite). Responsive PC/mobile, utilisable au clavier, `aria-live` sur les retours.
- En production, **un seul processus** : le serveur sert l'API (`/api/*`) et le build statique du client.

## Développement

Prérequis : Node ≥ 18.

```bash
# terminal 1 — API sur http://localhost:3001
cd server && npm install && npm run dev

# terminal 2 — client sur http://localhost:5173 (proxy /api → 3001)
cd web && npm install && npm run dev
```

Tests du domaine (normalisation, maîtrise, sélection, validation) et d'intégration du dépôt (bibliothèque, sessions phrases/mixtes, stats) :

```bash
cd server && npm test
```

## Production

```bash
cd web && npm run build      # génère web/dist
cd ../server && npm ci && npm start   # sert API + client sur le port 3001
```

Variables d'environnement : `PORT` (défaut 3001), `DB_PATH` (défaut `server/data/app.db`).

### Déploiement VPS / cloud

```bash
# 1. Image de données (pré-requis) : base SQLite initiale générée par le code serveur
docker build -f Dockerfile.db -t myflashcardapp/db .
# 2. Image applicative — le build échoue si l'image de données n'existe pas
docker build -t myflashcardapp .
mkdir -p data && docker compose up -d   # base persistée dans ./data, initialisée depuis /seed au 1er démarrage
```

Alternative : tirer l'image publiée par la CI de release plutôt que de builder sur le VPS :

```bash
IMAGE=ghcr.io/michanolnathan/koreanvocapp/myflashcardapp:latest docker compose up -d
```

Derrière un reverse-proxy HTTPS (Caddy/Nginx) ou via Tailscale — requis pour la PWA (contexte sécurisé).

**Sauvegarde** : `data/app.db` est le seul fichier d'état — le copier avant chaque mise à jour
(`cp data/app.db "data/backup-$(date +%Y%m%d-%H%M%S).app.db"`) et l'exporter régulièrement hors du VPS.

### PWA — installation sur téléphone

Le build client produit une PWA complète : manifeste, icônes (dont maskable et apple-touch), et service worker (`web/scripts/sw-template.js`, généré dans `dist/sw.js` par le plugin Vite de `web/vite.config.ts`).

- **Android (Chrome)** : menu ⋮ → *Installer l'application*. **iOS (Safari)** : Partager → *Sur l'écran d'accueil*.
- Le service worker exige un **contexte sécurisé** : HTTPS en production (reverse proxy Caddy/Nginx ou Tailscale, comme ci-dessus), ou `http://localhost` — sur Android en local, `adb reverse tcp:3001 tcp:3001` permet d'ouvrir `http://localhost:3001` depuis le téléphone. iOS exige HTTPS.
- **Hors ligne** : la coquille et les assets sont précacheés ; les lectures API (`GET`) renvoient la dernière valeur connue ; les écritures (répondre à un quiz, éditer un mot) nécessitent le réseau.
- Régénérer les icônes après modification du motif/couleurs : `cd web && node scripts/generate-icons.mjs` (Node pur, aucune dépendance).

## Données

Schéma : `words` → `meanings` ; `phrases` → `phrase_translations` (+ `phrase_vocab`, liens analyse seule) ; `sessions` → `questions` (cible signification **ou** phrase via `kind`) ; `attempt_log` (journal générique mots/phrases, source unique du calcul de maîtrise). L'édition d'un mot conserve l'historique des significations existantes (mise à jour en place par `id`) ; la bibliothèque de phrases est enrichie par upsert d'identifiants stables à chaque démarrage.

**Migration v0.3 (itération 2)** : à la première ouverture d'une base existante, les tables `questions` et `attempt_log` sont reconstruites pour supporter les deux types de cibles — **une sauvegarde horodatée du fichier base est créée automatiquement à côté** (`app.db.backup-…`) avant toute modification.

**Migration v0.5** : le champ « autres traductions » par signification (`meaning_translations`) dupliquant la multi-signification, chaque traduction alternative existante est convertie en signification supplémentaire du mot (catégorie et contexte héritées, indice non repris, doublons normalisés écartés) puis la table est supprimée — avec la même sauvegarde automatique préalable. Les traductions alternatives des **phrases** (`phrase_translations`) restent inchangées.
