#!/bin/sh
set -e
# Fix ownership of bind-mounted data directories at runtime.
# At container start the host-created bind-mount dirs may be owned by root;
# chown them before dropping privileges so nesuser can write snapshots/roms.
chown -R nesuser:nesuser /data/snapshots /data/roms 2>/dev/null || true
exec su-exec nesuser node server.js
