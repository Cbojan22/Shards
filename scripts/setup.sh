#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

echo "Setting up Python environment for Shards..."

# A venv built before the project was renamed has shebangs pinned to the old
# absolute path. pip then silently shells out to system Python and installs
# packages where the venv's own interpreter can't find them. Detect that case
# (the venv's python binary doesn't actually run) and rebuild from scratch.
NEED_REBUILD=0
if [ -d "$VENV_DIR" ]; then
    if ! "$VENV_DIR/bin/python3" -c 'import sys' >/dev/null 2>&1; then
        echo "Detected stale venv (python binary not callable). Rebuilding..."
        NEED_REBUILD=1
    elif ! "$VENV_DIR/bin/pip" --version >/dev/null 2>&1; then
        echo "Detected stale venv (pip shebang broken). Rebuilding..."
        NEED_REBUILD=1
    fi
fi

if [ "$NEED_REBUILD" -eq 1 ]; then
    rm -rf "$VENV_DIR"
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Activate and install
echo "Installing Python dependencies..."
source "$VENV_DIR/bin/activate"
pip install --upgrade pip -q
pip install -r "$SCRIPT_DIR/requirements.txt" -q

echo ""
echo "Python environment ready at: $VENV_DIR"
echo "Installed packages:"
pip list --format=columns | grep -Ei "whisper|opencv|numpy|torch|facenet"
echo ""
echo "Setup complete!"
