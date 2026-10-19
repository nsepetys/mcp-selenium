#!/bin/bash
# Startup for the headed, GPU-accelerated, host-mimicking Chrome MCP image
# (Dockerfile.chrome-headed). Brings up a real X display (Xvfb) so Chrome can
# run non-headless and hand WebGL/Vulkan frames to an actual display surface
# (the headless path has no compositor for that), then exposes the desktop
# over VNC/noVNC for watching, and finally hands off to the MCP server.
set -e

export XDG_RUNTIME_DIR=/tmp/runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

echo "[start-headed] launching Xvfb :99 (1920x1080x30)..."
Xvfb :99 -screen 0 1920x1080x30 -ac +extension GLX +render &
export DISPLAY=:99

echo "[start-headed] waiting for display :99..."
for i in $(seq 1 30); do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        echo "[start-headed] display :99 is ready."
        break
    fi
    sleep 1
done

echo "[start-headed] launching fluxbox..."
fluxbox >/tmp/fluxbox.log 2>&1 &

echo "[start-headed] launching x11vnc on :5900..."
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -bg -o /tmp/x11vnc.log

echo "[start-headed] launching noVNC (websockify 7900 -> 5900)..."
websockify --web=/usr/share/novnc 7900 localhost:5900 >/tmp/novnc.log 2>&1 &

echo "[start-headed] starting MCP server..."
exec node src/lib/server.js
