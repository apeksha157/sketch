#!/usr/bin/env bash
#
# Sketch — Setup Script
#
# Installs and configures Sketch on macOS or Linux.
# Can be run as: curl -fsSL https://raw.githubusercontent.com/canvasxai/sketch/main/scripts/setup.sh | bash
#
# What it does:
#   1. Installs Node.js 24, pnpm, and build tools (if missing)
#   2. Clones the repo to ~/sketch (or pulls if already cloned)
#   3. Builds the project
#   4. Creates ~/.sketch/data/ for runtime data
#   5. Generates .env pointing to the data directory
#   6. On Linux: offers to create a systemd service
#   7. On macOS: sets up pm2 for process management
#   8. Starts the server
#
# Safe to re-run (idempotent).

set -euo pipefail

REPO_URL="https://github.com/canvasxai/sketch.git"
INSTALL_DIR="$HOME/sketch"
DATA_DIR="$HOME/.sketch/data"
NODE_MAJOR=24
PORT=3000

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf "\033[1;34m==>\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m==>\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m==>\033[0m %s\n" "$1"; }
fail()  { printf "\033[1;31m==>\033[0m %s\n" "$1" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    *)      fail "Unsupported OS: $(uname -s)" ;;
  esac
}

node_version_ok() {
  if ! command_exists node; then return 1; fi
  local ver
  ver=$(node -v | sed 's/^v//' | cut -d. -f1)
  [ "$ver" -ge "$NODE_MAJOR" ] 2>/dev/null
}

# ---------------------------------------------------------------------------
# Install prerequisites
# ---------------------------------------------------------------------------

install_macos() {
  # Xcode CLI tools (for native modules like better-sqlite3)
  if ! xcode-select -p >/dev/null 2>&1; then
    info "Installing Xcode Command Line Tools..."
    xcode-select --install 2>/dev/null || true
    warn "If a dialog appeared, complete the install and re-run this script."
    exit 0
  fi

  # Homebrew
  if ! command_exists brew; then
    info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add Homebrew to PATH for this session
    if [ -f /opt/homebrew/bin/brew ]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -f /usr/local/bin/brew ]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi

  # Node.js
  if ! node_version_ok; then
    info "Installing Node.js $NODE_MAJOR via Homebrew..."
    brew install "node@$NODE_MAJOR"
    brew link --overwrite "node@$NODE_MAJOR" 2>/dev/null || true
  fi
  ok "Node.js $(node -v)"

  # pnpm
  if ! command_exists pnpm; then
    info "Installing pnpm..."
    npm install -g pnpm
  fi
  ok "pnpm $(pnpm -v)"

  # pm2 (process manager for macOS)
  if ! command_exists pm2; then
    info "Installing pm2..."
    npm install -g pm2
  fi
  ok "pm2 $(pm2 -v)"
}

install_linux() {
  info "Installing system dependencies..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq build-essential curl git unzip >/dev/null

  # Node.js via fnm
  if ! node_version_ok; then
    if ! command_exists fnm; then
      info "Installing fnm (Node version manager)..."
      curl -fsSL https://fnm.vercel.app/install | bash
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$(fnm env)"
    fi
    info "Installing Node.js $NODE_MAJOR..."
    fnm install "$NODE_MAJOR"
    fnm default "$NODE_MAJOR"
    eval "$(fnm env)"
  fi
  ok "Node.js $(node -v)"

  # pnpm
  if ! command_exists pnpm; then
    info "Installing pnpm..."
    npm install -g pnpm
  fi
  ok "pnpm $(pnpm -v)"
}

# ---------------------------------------------------------------------------
# Clone / update repo
# ---------------------------------------------------------------------------

setup_repo() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing repo at $INSTALL_DIR..."
    git -C "$INSTALL_DIR" pull --ff-only
  else
    info "Cloning Sketch to $INSTALL_DIR..."
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

build() {
  info "Installing dependencies..."
  cd "$INSTALL_DIR"
  pnpm install

  info "Building..."
  pnpm build
  ok "Build complete"
}

# ---------------------------------------------------------------------------
# Data directory and .env
# ---------------------------------------------------------------------------

setup_data() {
  mkdir -p "$DATA_DIR"
  ok "Data directory: $DATA_DIR"
}

setup_env() {
  local env_file="$INSTALL_DIR/.env"

  if [ -f "$env_file" ]; then
    ok ".env already exists, skipping"
    return
  fi

  info "Creating .env..."
  cat > "$env_file" << EOF
# Sketch — Environment Configuration
# LLM credentials, Slack tokens, and WhatsApp pairing are configured
# through the web UI during onboarding.

DB_TYPE=sqlite
SQLITE_PATH=$DATA_DIR/sketch.db
DATA_DIR=$DATA_DIR
PORT=$PORT
LOG_LEVEL=info
EOF
  ok ".env created at $env_file"
}

# ---------------------------------------------------------------------------
# Linux: systemd service
# ---------------------------------------------------------------------------

setup_systemd() {
  local node_path
  node_path="$(readlink -f "$(which node)")"
  local node_dir
  node_dir="$(dirname "$node_path")"
  local user
  user="$(whoami)"
  local service_file="/etc/systemd/system/sketch.service"

  if [ -f "$service_file" ]; then
    warn "systemd service already exists at $service_file"
    info "Updating service file..."
  fi

  info "Creating systemd service..."
  sudo tee "$service_file" > /dev/null << EOF
[Unit]
Description=Sketch AI Assistant
After=network.target

[Service]
Type=simple
User=$user
WorkingDirectory=$INSTALL_DIR
Environment=PATH=$node_dir:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$node_path packages/server/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=$INSTALL_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable sketch
  ok "systemd service created"
}

start_systemd() {
  info "Starting Sketch via systemd..."
  sudo systemctl restart sketch

  # Wait a moment and check status
  sleep 2
  if sudo systemctl is-active --quiet sketch; then
    ok "Sketch is running"
  else
    warn "Sketch may not have started correctly. Check logs:"
    echo "  sudo journalctl -u sketch -f"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# macOS: pm2
# ---------------------------------------------------------------------------

setup_pm2() {
  cd "$INSTALL_DIR"

  # Stop existing instance if running
  pm2 delete sketch 2>/dev/null || true

  info "Starting Sketch via pm2..."
  pm2 start packages/server/dist/index.js --name sketch

  # Configure pm2 to start on boot
  pm2 save
  local startup_cmd
  startup_cmd=$(pm2 startup 2>&1 | grep 'sudo' | head -1)
  if [ -n "$startup_cmd" ]; then
    info "To start Sketch on boot, run:"
    echo "  $startup_cmd"
  fi

  ok "Sketch is running via pm2"
  echo "  pm2 logs sketch    — view logs"
  echo "  pm2 restart sketch — restart"
  echo "  pm2 stop sketch    — stop"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo "  ┌─────────────────────────────┐"
  echo "  │     Sketch Setup Script      │"
  echo "  └─────────────────────────────┘"
  echo ""

  local os
  os=$(detect_os)
  info "Detected OS: $os"

  # Install prerequisites
  case "$os" in
    macos) install_macos ;;
    linux) install_linux ;;
  esac

  # Clone / update
  setup_repo

  # Build
  build

  # Data + env
  setup_data
  setup_env

  # Process management
  case "$os" in
    linux)
      setup_systemd
      start_systemd
      ;;
    macos)
      setup_pm2
      ;;
  esac

  echo ""
  ok "Setup complete!"
  echo ""
  echo "  Open http://localhost:$PORT to finish setup."
  echo "  The onboarding wizard will walk you through:"
  echo "    1. Creating an admin account"
  echo "    2. Naming your bot"
  echo "    3. Connecting Slack"
  echo "    4. Configuring your LLM provider"
  echo ""
  echo "  Data is stored at: $DATA_DIR"
  echo "  Repo is at:        $INSTALL_DIR"
  echo ""
}

main "$@"
