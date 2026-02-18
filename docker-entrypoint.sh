#!/bin/sh
# Entrypoint script for selenium-mcp container
# Starts socat forwarder for localhost:8000 access, then runs MCP server

# Start Xvfb for non-headless browser support
# Set ENABLE_DISPLAY=1 to enable virtual display
if [ -n "$ENABLE_DISPLAY" ]; then
    echo "Starting Xvfb virtual display on :99"
    Xvfb :99 -screen 0 1920x1080x24 &
    export DISPLAY=:99
fi

# Start socat to forward localhost:8000 -> host.docker.internal:8000
# This enables OAuth callbacks to work when browser navigates to localhost
if [ -n "$ENABLE_LOCALHOST_FORWARD" ]; then
    echo "Starting socat forwarder: localhost:8000 -> host.docker.internal:8000"
    socat TCP-LISTEN:8000,bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:8000 &
fi

# Run the MCP server
exec node src/lib/server.js "$@"
