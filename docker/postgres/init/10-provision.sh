#!/bin/sh
set -eu

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$FLOWFORGE_OWNER_PASSWORD" \
  -v app_password="$FLOWFORGE_APP_PASSWORD" \
  -f /flowforge/provision.sql
