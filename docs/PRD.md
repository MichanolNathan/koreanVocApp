# PRD — Application de révision de vocabulaire coréen

Version 0.2 — Cadrage fonctionnel **verrouillé** (décisions §11 intégrées).
La v0.1 (fichier `PRD_revision_vocabulaire_coreen_v0.1.txt`, hors repo) est remplacée par ce document.

## 1. PRÉSENTATION DU PROJET

### 1.1 Objectif
Application personnelle permettant d'apprendre, mémoriser et réviser du vocabulaire coréen à travers des exercices interactifs : constitution d'un dictionnaire coréen–français personnel, quiz de traduction, suivi de la maîtrise. Exploitation ultérieure de dictionnaires externes par niveau CECRL (A1, A2, B1…).

### 1.2 Principes directeurs
- Simplicité, progressivité, personnalisation.
- Évolutivité : nouveaux types d'exercices sans refonte de l'architecture.
- Modularité : sources de vocabulaire / moteur d'exercices / résultats séparés.

## 2. GESTION DU VOCABULAIRE

### 2.1 Dictionnaire personnel
Ajout manuel de mots coréens. Chaque mot :
- Mot coréen (obligatoire, unique).
- Romanisation, catégorie grammaticale (facultatifs).
- Une ou plusieurs **significations**.

Chaque signification :
- Traduction principale (obligatoire).
- Traductions alternatives acceptées (facultatives, liste).
- Indice (facultatif) — utilisé par le bouton indice du quiz.
- Contexte d'utilisation (facultatif).
- Exemple coréen + traduction (facultatifs).

### 2.2 Significations indépendantes
Exemple 사과 : « pomme » (Alimentation), « excuses » (Relations sociales), « regrets » (Expression personnelle). Chaque signification possède sa propre traduction, son indice, son contexte, son historique et son niveau de maîtrise. La maîtrise d'une traduction n'implique pas celle des autres sens.

## 3. SOURCES DE VOCABULAIRE

- **Dictionnaire personnel** (V1) : saisie manuelle, gestion libre.
- **Dictionnaires externes** (V2) : listes par niveau CECRL, import.

Les sources sont indépendantes du moteur d'exercices : le champ `source` est prévu dès le schéma V1.

## 4. MOTEUR D'EXERCICES

### 4.1 Généralités
Le moteur récupère les significations à réviser depuis une source, puis les transmet au type d'exercice. Ajout de nouveaux exercices sans toucher au dictionnaire.

### 4.2 Exercice « traduction » — règles verrouillées
- Session de **15 questions** ; si la source contient moins de 15 significations éligibles, la session les utilise toutes.
- Questions présentées une par une ; mot coréen affiché ; saisie libre en français.
- Bouton « Indice » explicite : révèle l'indice de la signification cible ; jamais automatique ; usage enregistré par question ; une réponse correcte avec indice reste correcte (mais vaut 0,6 au lieu de 1 dans le score de maîtrise).
- **Une seule réponse par question** ; la bonne réponse est rappelée dans les résultats.
- **Validation stricte normalisée** : la réponse est correcte si, après normalisation, elle égale la traduction principale ou une traduction alternative de l'une des significations du mot. Normalisation : minuscules, suppression des accents, de la ponctuation, des articles définis/indéfinis en tête (le, la, l', les, un, une, du, de, des), pluriel (« s » final du dernier mot ignoré), espaces compressés.
- **Multi-significations** : si la réponse correspond à une autre signification du mot que celle visée, elle est comptée correcte ; la tentative est alors enregistrée sur la signification correspondante ; les résultats affichent tous les sens du mot.

### 4.3 Résultats (fin de session uniquement)
Score /15, pourcentage, incorrectes, indices utilisés, correctes sans indice, et détail par question (mot, réponse utilisateur, traduction attendue, statut). Pour les erreurs : autres significations et contextes affichés.

## 5. MAÎTRISE

### 5.1 Objectif
Analyse des résultats cumulés pour proposer des révisions adaptées aux lacunes réelles.

### 5.2 Niveaux
`Maîtrisé`, `À renforcer`, `Non maîtrisé`, plus `Non évalué` (aucune tentative).

### 5.3 Calcul — verrouillé
Par signification, sur les **10 dernières tentatives** : moyenne pondérée exponentiellement (EWMA, λ = 0,6 — les tentatives récentes pèsent plus). Valeur d'une tentative : 1,0 (correcte sans indice), 0,6 (correcte avec indice), 0 (incorrecte).

Niveau résultant :
- 0 tentative → **Non évalué**.
- Score ≥ 0,8 et ≥ 3 tentatives → **Maîtrisé**.
- Score ≥ 0,4 (sinon) → **À renforcer**.
- Score < 0,4 et ≥ 2 tentatives → **Non maîtrisé**.
- 1 seule tentative, incorrecte → **À renforcer** (l'erreur isolée ne dégrade pas — exigence §5.3 v0.1).

### 5.4 Agrégation par mot
- Au moins une signification non maîtrisée → mot **Non maîtrisé**.
- Sinon au moins une signification à renforcer **ou non évaluée** → **À renforcer**.
- Sinon (toutes maîtrisées) → **Maîtrisé**.
(Clarté apportée à la v0.1 : une signification jamais évaluée maintient le mot « à renforcer » au mieux.)

## 6. HISTORIQUE ET RÉVISIONS CIBLÉES

### 6.1 Historique
Chaque session conserve questions, réponses, statuts, indices, dates. Les tentatives alimentent un journal (`attempt_log`) utilisé par le calcul de maîtrise.

### 6.2 Points faibles identifiés automatiquement
Mots/significations régulièrement ratés, contextes problématiques, significations dépendantes des indices.

### 6.3 Modes de quiz — verrouillés
Tous en 15 questions (ou moins si insuffisamment de candidats, complétion par priorité décroissante) :
- **Standard** : pondéré par faiblesse — poids Non maîtrisé 5, À renforcer 3, Non évalué 2, Maîtrisé 1 ; tirage pondéré sans remise.
- **Non maîtrisées** : cible les non maîtrisées, complétée par à renforcer puis non évaluées.
- **À renforcer** : cible les à renforcer, complétée par non maîtrisées puis non évaluées.
- **Mixte** : 70 % faibles (non maîtrisées + à renforcer), 30 % autres.
- **Par contexte** : significations d'un contexte donné, complétées par tirage pondéré standard.

Maîtrise recalculée après chaque session (à la lecture, à partir du journal — pas de dérivation stockée sujette à incohérence).

## 7. ARCHITECTURE

- **Serveur** : Node + TypeScript + Express + SQLite (fichier unique, sauvegarde triviale sur VPS). Validation des réponses côté serveur (les traductions attendues ne transitent jamais vers le client avant la réponse).
- **Client** : SPA React + TypeScript (Vite), responsive PC/mobile, utilisable au clavier, `aria-live` pour les retours.
- **Déploiement** : un seul processus — le serveur sert l'API et le build statique du client. Cible : VPS ou free tier cloud (§11).
- Modules serveur : `db` (schéma), `mastery` (EWMA), `engine` (sélection + validation), `routes` (API), indépendants les uns des autres autant que possible.

## 8. PÉRIMÈTRE

**V1 (ce repo)** : dictionnaire personnel complet (mots + significations + trads alternatives), quiz traduction 15 questions, résultats détaillés, historique, maîtrise EWMA, points faibles, quiz ciblés.

**V2** : import dictionnaires externes, sélection CECRL. **V2+** : autres types d'exercices.

## 9. EXIGENCES NON FONCTIONNELLES

Maintenabilité modulaire ; persistance fichier SQLite ; résultats reproductibles (validation strictement côté serveur) ; accessibilité clavier + lecteurs d'écran ; UTF-8 intégral (Hangul + français).

## 10. DÉCISIONS VERROUILLÉES (répond au §10 v0.1)

| Point ouvert v0.1 | Décision v0.2 |
|---|---|
| Sélection des 15 questions | Pondérée par faiblesse, sans remise (§6.3) |
| Validation des traductions | Stricte normalisée, traductions principales + alternatives ; multi-sens accepté (§4.2) |
| Tentatives | Une seule réponse par question |
| Indices | Indice propre à chaque signification, sur bouton |
| Calcul de maîtrise | EWMA λ=0,6 sur 10 dernières tentatives, seuils §5.3 |
| Dictionnaires externes | V2 — champ `source` prévu au schéma |
| Interface | Web responsive, full-stack Node/TS + SQLite, hébergement cloud VPS/free tier |
