#!/usr/bin/env bash
# Installs the PostgreSQL 17 client tools (pg_dump, pg_dumpall, pg_restore, psql) AND the server binaries (initdb, pg_ctl, postgres) for the
# restore drill (backend/test/backup.restore-drill.test.ts): the drill restores a backup into a THROWAWAY SECOND CLUSTER it creates with
# initdb, because a restore into a cluster that has never heard of the application is the only honest test of roles, role defaults and the
# password. CI and development only; nothing here is part of a production image.
#
# Three details that matter:
#  - the runner image ships an OLDER client (PostgreSQL 16) first on PATH: the scripts and the test look for version 17 in PG_BIN_DIR
#    first (exported below through GITHUB_ENV) and refuse any other major, so the wrong pg_dump can never be used by accident;
#  - installing the server package would normally create and START a cluster on port 5432, where the postgres:17 service container already
#    listens: `create_main_cluster = false` is written BEFORE the install, so nothing is created and nothing is started;
#  - the PGDG repository key is checked against its published FINGERPRINT before apt is allowed to trust it.
#
# Usage: bash .github/scripts/install-postgres-tools.sh
set -euo pipefail

MAJOR=17
# https://www.postgresql.org/download/linux/ubuntu/ : the signing key of apt.postgresql.org (ACCC4CF8)
FINGERPRINT="B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8"
KEYRING="/usr/share/keyrings/pgdg.gpg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -sSfL --retry 3 -o "$WORK/pgdg.asc" https://www.postgresql.org/media/keys/ACCC4CF8.asc
ACTUAL="$(gpg --show-keys --with-colons "$WORK/pgdg.asc" | awk -F: '$1 == "fpr" { print $10; exit }')"
if [ "$ACTUAL" != "$FINGERPRINT" ]; then
  echo "PGDG key fingerprint mismatch: expected $FINGERPRINT, got $ACTUAL" >&2
  exit 1
fi
sudo gpg --dearmor --yes -o "$KEYRING" "$WORK/pgdg.asc"

CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
echo "deb [signed-by=$KEYRING] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list >/dev/null

sudo mkdir -p /etc/postgresql-common
echo "create_main_cluster = false" | sudo tee /etc/postgresql-common/createcluster.conf >/dev/null

sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update
sudo apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends \
  "postgresql-client-${MAJOR}" "postgresql-${MAJOR}"

BIN="/usr/lib/postgresql/${MAJOR}/bin"
for tool in pg_dump pg_dumpall pg_restore psql initdb pg_ctl; do
  "$BIN/$tool" --version
done
if [ -n "${GITHUB_ENV:-}" ]; then echo "PG_BIN_DIR=$BIN" >> "$GITHUB_ENV"; fi
