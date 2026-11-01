# MyFlashcardApp

Application personnelle de révision de vocabulaire coréen (coréen → français) : dictionnaire personnel, quiz de traduction, suivi individuel de la maîtrise par signification, et quiz ciblés sur les lacunes.

Le cadrage fonctionnel complet et les décisions verrouillées sont dans [`docs/PRD.md`](docs/PRD.md).

## Fonctionnalités (V1)

- **Dictionnaire personnel** : mots coréens avec romanisation, catégorie grammaticale, et une ou plusieurs **significations** (traduction principale + traductions alternatives acceptées, indice, contexte, exemples).
- **Quiz de traduction** : 15 questions (ou moins si le dictionnaire est petit), une réponse par question, indice sur demande, validation stricte normalisée côté serveur (casse, accents, articles, pluriel ; une traduction d'une *autre* signification du mot reste correcte).
- **Maîtrise par signification** : EWMA (λ = 0,6) sur les 10 dernières tentatives — réussite sans indice 1,0 · avec indice 0,6 · échec 0. Niveaux : Maîtrisé / À renforcer / Non maîtrisé / Non évalué ; une erreur isolée ne dégrade pas.
- **Analyse et quiz ciblés** : points faibles, dépendance aux indices, contextes problématiques ; modes Standard (pondéré par faiblesse), Non maîtrisées, À renforcer, Mixte (70/30), Par contexte. Chaque quiz peut cibler un dictionnaire : Personnel, Officiel ou tous.
- **Historique** des sessions avec résultats détaillés.

## Branches & validation des images

- `main` — code en production (image déployée sur le VPS). Pas de commit direct.
- `develop` — branche de développement courant : tout le travail part d'ici.
- `test` — couloir de validation des images Docker : merger `develop` dans `test`
  (puis pousser) déclenche le workflow *test-images-docker*
  ([`.github/workflows/docker-test.yml`](.github/workflows/docker-test.yml)) :
  build des deux images (`Dockerfile.db` puis `Dockerfile`) et test fonctionnel du
  conteneur ([`scripts/docker-smoke.sh`](scripts/docker-smoke.sh) : démarrage,
  initialisation de la base dans le volume, client statique, lecture/écriture API,
  validation d'entrée, persistance après redémarrage). Une image ne part en
  production que si ce job est vert.

## Architecture

- `server/` — Node + TypeScript + Express. SQLite via **sql.js** (WASM, zéro module natif : aucune chaîne de compilation nécessaire). La base tient en mémoire et est persistée dans un fichier unique à chaque écriture. Validation des réponses exclusivement côté serveur (les traductions attendues ne quittent jamais le serveur avant la réponse).
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

Tests unitaires du domaine (normalisation, maîtrise, sélection, validation) :

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

Schéma : `words` → `meanings` → `meaning_translations` ; `sessions` → `questions` ; `attempt_log` (journal des tentatives, source unique du calcul de maîtrise). L'édition d'un mot conserve l'historique des significations existantes (mise à jour en place par `id`).
