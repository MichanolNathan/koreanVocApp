#!/usr/bin/env bash
# Test fonctionnel d'une image Docker applicative déjà construite — utilisé par
# la branche `test` (workflow .github/workflows/docker-test.yml — voir README).
#   4. lecture API (GET /api/words) ;
#   5. écriture API (POST + GET + DELETE /api/words/:id) ;
#   5b. quiz de phrases de la bibliothèque intégrée (itération 2) : session
#       de 15 questions, indice, réponse évaluée côté serveur ;
#   6. validation d'entrée (POST invalide -> 400) ;
#   7. persistance des données après redémarrage du conteneur (la base du
#      volume ne doit pas être écrasée par le seed).
#
# Usage : ./scripts/docker-smoke.sh <image> [port_hôte]
# Sort 0 si tout passe ; nettoie conteneur et volume dans tous les cas.

set -euo pipefail

image="${1:?Usage: docker-smoke.sh <image> [port_hôte]}"
port="${2:-30080}"
base="http://127.0.0.1:${port}"
name="smoke-$$"
volume="smoke-data-$$"
cid=""

cleanup() {
  if [ -n "$cid" ]; then docker rm -f "$cid" >/dev/null 2>&1 || true; fi
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "ÉCHEC : $*" >&2; exit 1; }
pass() { echo "OK : $*"; }

start() {
  cid="$(docker run -d --name "$name" -p "127.0.0.1:${port}:3001" -v "${volume}:/app/data" "$image")"
}

wait_up() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS "$base/api/stats" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$cid" >&2 || true
  fail "le service ne répond pas sur $base/api/stats après ${i}s"
}

start
wait_up
pass "service démarré, /api/stats répond (200)"

# 2. Base initialisée dans le volume par l'entrypoint (copie depuis /seed)
docker exec "$cid" test -f /app/data/app.db || fail "/app/data/app.db absent — volume non initialisé"
pass "base SQLite initialisée dans le volume"

# 3. Client statique servi par le même processus
curl -fsS "$base/" | grep -qi '<!doctype html' || fail "le client statique n'est pas servi à la racine (/)"
pass "client statique servi à /"

# 4. Lecture API
curl -fsS "$base/api/words" | grep -q '^\[' || fail "GET /api/words ne renvoie pas une liste JSON"
pass "GET /api/words -> liste JSON"

# 4b. Dictionnaire officiel livré : disponible dès l'installation.
noff="$(curl -fsS "$base/api/words?source=official" | grep -o '"source":"official"' | wc -l | tr -d ' ')"
[ "$noff" -ge 40 ] || fail "dictionnaire officiel : $noff mots, au moins 40 attendus"
curl -fsS "$base/api/words?source=official" | grep -q '주말' || fail "dictionnaire officiel : 주말 absent"
pass "dictionnaire officiel livré ($noff mots)"

# 5. Écriture API : POST puis relecture du mot créé.
#    Le corps passe par un fichier (--data-binary @) : certains curl Windows
#    mutilent l'UTF-8 passé en argument ; les octets d'un fichier restent exacts.
payload="smoke-payload.$$"
cat >"$payload" <<'EOF'
{"korean":"테스트","romanization":"teseuteu","meanings":[{"translation":"test"}]}
EOF
created="$(curl -fsS -X POST "$base/api/words" -H 'Content-Type: application/json' --data-binary @"$payload")"
rm -f "$payload"
id="$(printf '%s' "$created" | grep -o '"id":[0-9]\+' | head -1 | cut -d: -f2)"
[ -n "$id" ] || fail "POST /api/words n'a pas renvoyé d'id : $created"
curl -fsS "$base/api/words/$id" | grep -q '테스트' || fail "GET /api/words/$id ne contient pas le mot créé"
pass "POST + GET /api/words/$id -> mot créé relu"

# 5b. Quiz de phrases (itération 2) : bibliothèque locale, 15 questions,
#     aucune traduction attendue exposée avant la réponse.
session="$(curl -fsS -X POST "$base/api/sessions" -H 'Content-Type: application/json' -d '{"kind":"phrases","mode":"standard"}')"
nq="$(printf '%s' "$session" | grep -o '"kind":"phrase"' | wc -l | tr -d ' ')"
[ "$nq" = "15" ] || fail "quiz de phrases : $nq questions phrase, 15 attendues"
if printf '%s' "$session" | grep -q 'expected'; then fail "quiz de phrases : traduction attendue exposée dans la session"; fi
qid="$(printf '%s' "$session" | grep -o '"questions":\[{"id":[0-9]\+' | grep -o '[0-9]\+$')"
[ -n "$qid" ] || fail "quiz de phrases : id de question introuvable"
sid="$(printf '%s' "$session" | grep -o '^{"id":[0-9]\+' | grep -o '[0-9]\+$')"
curl -fsS -X POST "$base/api/sessions/$sid/questions/$qid/hint" | grep -q '"hint"' || fail "quiz de phrases : indice absent"
answer_payload="smoke-answer.$$"
printf '%s' '{"answer":"réponse volontairement fausse"}' >"$answer_payload"
curl -fsS -X POST "$base/api/sessions/$sid/questions/$qid/answer" -H 'Content-Type: application/json' \
  --data-binary @"$answer_payload" | grep -q '"kind":"phrase"' || fail "quiz de phrases : réponse non évaluée"
rm -f "$answer_payload"
pass "quiz de phrases : 15 questions, indice, réponse évaluée (serveur)"

# 6. Validation d'entrée : mot vide -> 400
# -w %{http_code} en fin de sortie : les 3 derniers caractères sont le code
# (portable — pas de /dev/null, que certains curl Windows ne savent pas ouvrir).
code="$(curl -s -w '%{http_code}' -X POST "$base/api/words" \
  -H 'Content-Type: application/json' -d '{"korean":"","meanings":[]}' | tail -c 3)"
[ "$code" = "400" ] || fail "POST invalide -> HTTP $code, 400 attendu"
pass "validation d'entrée (400 sur corps invalide)"

# 7. Persistance après redémarrage : la base du volume doit être conservée
docker rm -f "$cid" >/dev/null
cid=""
start
wait_up
curl -fsS "$base/api/words/$id" | grep -q '테스트' || fail "le mot créé a disparu après redémarrage du conteneur"
pass "données persistées après redémarrage"

code="$(curl -s -w '%{http_code}' -X DELETE "$base/api/words/$id" | tail -c 3)"
[ "$code" = "204" ] || fail "DELETE /api/words/$id -> HTTP $code, 204 attendu"
pass "DELETE /api/words/$id -> 204"

echo "SMOKE TEST OK — image $image fonctionnelle"
