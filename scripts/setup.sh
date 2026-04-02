#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

echo "Setting up Python environment for Video Clipper..."

# Create venv if it doesn't exist
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
pip list --format=columns | grep -E "whisper|opencv|numpy"
echo ""
echo "Setup complete!"
