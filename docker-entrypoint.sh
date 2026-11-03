#!/bin/sh
# Entrypoint script for selenium-mcp container
# Starts socat forwarders and MCP server

# Start Xvfb for non-headless browser support
# Set ENABLE_DISPLAY=1 to enable virtual display
if [ -n "$ENABLE_DISPLAY" ]; then
    echo "Starting Xvfb virtual display on :99"
    Xvfb :99 -screen 0 1920x1080x24 &
    export DISPLAY=:99
fi

# Forward localhost ports -> host.docker.internal via socat
# LOCALHOST_FORWARD_PORTS: comma-separated list of ports (e.g. "8000,5001,3000")
# Keeps this image application-agnostic — consumers configure which ports they need.
if [ -n "$LOCALHOST_FORWARD_PORTS" ]; then
    for PORT in $(echo "$LOCALHOST_FORWARD_PORTS" | tr ',' ' '); do
        echo "socat: localhost:$PORT -> host.docker.internal:$PORT"
        socat TCP-LISTEN:"$PORT",bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:"$PORT" &
    done
fi

# Run the MCP server
exec node src/lib/server.js "$@"
