#!/usr/bin/env bash
# Test fonctionnel d'une image Docker applicative déjà construite — utilisé par
# la branche `test` (workflow .github/workflows/docker-test.yml — voir README).
#
# Vérifie, dans un conteneur jetable avec son volume :
#   1. démarrage du service et santé (/api/stats) ;
#   2. initialisation de la base SQLite dans le volume par l'entrypoint ;
#   3. service du client statique à la racine ;
#   4. lecture API (GET /api/words) ;
#   5. écriture API (POST + GET + DELETE /api/words/:id) ;
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

# 5. Écriture API : POST puis relecture du mot créé
created="$(curl -fsS -X POST "$base/api/words" -H 'Content-Type: application/json' \
  -d '{"korean":"테스트","romanization":"teseuteu","category":"noun","meanings":[{"translation":"test"}]}')"
id="$(printf '%s' "$created" | grep -o '"id":[0-9]\+' | head -1 | cut -d: -f2)"
[ -n "$id" ] || fail "POST /api/words n'a pas renvoyé d'id : $created"
curl -fsS "$base/api/words/$id" | grep -q '테스트' || fail "GET /api/words/$id ne contient pas le mot créé"
pass "POST + GET /api/words/$id -> mot créé relu"

# 6. Validation d'entrée : mot vide -> 400
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/words" \
  -H 'Content-Type: application/json' -d '{"korean":"","meanings":[]}')"
[ "$code" = "400" ] || fail "POST invalide -> HTTP $code, 400 attendu"
pass "validation d'entrée (400 sur corps invalide)"

# 7. Persistance après redémarrage : la base du volume doit être conservée
docker rm -f "$cid" >/dev/null
cid=""
start
wait_up
curl -fsS "$base/api/words/$id" | grep -q '테스트' || fail "le mot créé a disparu après redémarrage du conteneur"
pass "données persistées après redémarrage"

code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$base/api/words/$id")"
[ "$code" = "204" ] || fail "DELETE /api/words/$id -> HTTP $code, 204 attendu"
pass "DELETE /api/words/$id -> 204"

echo "SMOKE TEST OK — image $image fonctionnelle"
