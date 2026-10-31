# MyFlashcardApp

Application personnelle de révision de vocabulaire coréen (coréen → français) : dictionnaire personnel, quiz de traduction, suivi individuel de la maîtrise par signification, et quiz ciblés sur les lacunes.

Le cadrage fonctionnel complet et les décisions verrouillées sont dans [`docs/PRD.md`](docs/PRD.md).

## Fonctionnalités (V1)

- **Dictionnaire personnel** : mots coréens avec romanisation, catégorie grammaticale, et une ou plusieurs **significations** (traduction principale + traductions alternatives acceptées, indice, contexte, exemples).
- **Quiz de traduction** : 15 questions (ou moins si le dictionnaire est petit), une réponse par question, indice sur demande, validation stricte normalisée côté serveur (casse, accents, articles, pluriel ; une traduction d'une *autre* signification du mot reste correcte).
- **Maîtrise par signification** : EWMA (λ = 0,6) sur les 10 dernières tentatives — réussite sans indice 1,0 · avec indice 0,6 · échec 0. Niveaux : Maîtrisé / À renforcer / Non maîtrisé / Non évalué ; une erreur isolée ne dégrade pas.
- **Analyse et quiz ciblés** : points faibles, dépendance aux indices, contextes problématiques ; modes Standard (pondéré par faiblesse), Non maîtrisées, À renforcer, Mixte (70/30), Par contexte. Chaque quiz peut cibler un dictionnaire : Personnel, Officiel ou tous.
- **Historique** des sessions avec résultats détaillés.

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

1. Cloner le dépôt, `cd web && npm ci && npm run build`, puis `cd ../server && npm ci`.
2. `PORT=3001 npm start` (derrière un reverse-proxy HTTPS type Caddy/Nginx, ou via Tailscale).
3. **Sauvegarde** : copier `server/data/app.db` régulièrement — c'est le seul fichier d'état.

## Données

Schéma : `words` → `meanings` → `meaning_translations` ; `sessions` → `questions` ; `attempt_log` (journal des tentatives, source unique du calcul de maîtrise). L'édition d'un mot conserve l'historique des significations existantes (mise à jour en place par `id`).
