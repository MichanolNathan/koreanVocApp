#!/bin/sh
# Initialise la base du volume depuis la base embarquée (image myflashcardapp/db)
# uniquement si le volume est vide — les données existantes ne sont jamais écrasées.
set -e
DB_PATH="${DB_PATH:-/app/data/app.db}"
if [ ! -f "$DB_PATH" ] && [ -f /seed/app.db ]; then
  echo "Base absente — initialisation depuis /seed/app.db"
  mkdir -p "$(dirname "$DB_PATH")"
  cp /seed/app.db "$DB_PATH"
fi
exec "$@"
