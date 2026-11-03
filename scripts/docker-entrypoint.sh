#!/bin/sh
set -eu

# A new Fly Volume is owned by root. Grant the app user access before dropping root.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /data
  chown node:node /data
  chmod 700 /data
  exec gosu node "$@"
fi
exec "$@"
