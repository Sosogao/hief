#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIEF Stack — One-click start script
# Usage: ./deploy/scripts/start.sh [--local | --testnet | --help]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()  { echo -e "${BLUE}[HIEF]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }

MODE="${1:---local}"

print_banner() {
  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║   HIEF — Hybrid Intent Execution Framework       ║${NC}"
  echo -e "${BLUE}║   AI DeFi Intent Infrastructure                  ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
}

check_deps() {
  log "Checking dependencies..."
  command -v docker  >/dev/null 2>&1 || err "Docker not found. Install: https://docs.docker.com/get-docker/"
  command -v docker compose version >/dev/null 2>&1 || err "Docker Compose v2 not found."
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"
}

check_env() {
  if [ ! -f "$ROOT_DIR/.env" ]; then
    warn ".env not found. Copying from .env.example..."
    cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
    warn "Please edit .env with your API keys before proceeding."
    if [ "$MODE" = "--testnet" ]; then
      err "Testnet mode requires a configured .env file."
    fi
  fi
  ok ".env found"
}

build_packages() {
  log "Building TypeScript packages..."
  cd "$ROOT_DIR"
  pnpm install --frozen-lockfile 2>/dev/null || npm install
  pnpm --filter @hief/common build
  ok "Packages built"
}

start_local() {
  log "Starting HIEF stack in LOCAL mode (no real keys needed)..."
  cd "$ROOT_DIR"

  # Use a minimal local override
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.local.yml \
    up -d --build

  wait_for_services
  print_endpoints
}

start_testnet() {
  log "Starting HIEF stack in TESTNET mode (Base Sepolia)..."
  cd "$ROOT_DIR"

  # Validate required keys
  source .env
  [ -z "${BASE_SEPOLIA_RPC_URL:-}" ] && err "BASE_SEPOLIA_RPC_URL is required for testnet mode"
  [ -z "${OPENAI_API_KEY:-}" ]       && err "OPENAI_API_KEY is required for testnet mode"

  docker compose up -d --build

  wait_for_services
  print_endpoints
}

wait_for_services() {
  log "Waiting for services to be healthy..."
  local services=("3001" "3002" "3003" "3004" "3000" "8080")
  local names=("Intent Bus" "Reputation API" "Policy Engine" "Solver" "Agent" "Explorer")
  local max_wait=60
  local waited=0

  for i in "${!services[@]}"; do
    local port="${services[$i]}"
    local name="${names[$i]}"
    local ready=false

    while [ $waited -lt $max_wait ]; do
      if curl -sf "http://localhost:$port/health" >/dev/null 2>&1 || \
         curl -sf "http://localhost:$port" >/dev/null 2>&1; then
        ok "$name (port $port)"
        ready=true
        break
      fi
      sleep 2
      waited=$((waited + 2))
    done

    if [ "$ready" = false ]; then
      warn "$name (port $port) — not responding after ${max_wait}s (may still be starting)"
    fi
  done
}

print_endpoints() {
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}  HIEF Stack is running!${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
  echo ""
  echo "  🤖  Agent API        →  http://localhost:3000"
  echo "  🚌  Intent Bus       →  http://localhost:3001"
  echo "  ⭐  Reputation API   →  http://localhost:3002"
  echo "  🛡️   Policy Engine   →  http://localhost:3003"
  echo "  🔄  Solver           →  http://localhost:3004"
  echo "  🔍  Intent Explorer  →  http://localhost:8080"
  echo ""
  echo "  Quick test:"
  echo '  curl -X POST http://localhost:3000/v1/chat \'
  echo '    -H "Content-Type: application/json" \'
  echo '    -d '"'"'{"message":"swap 100 USDC to ETH","userAddress":"0xYOUR_ADDRESS"}'"'"
  echo ""
  echo "  View logs:  docker compose logs -f"
  echo "  Stop:       docker compose down"
  echo ""
}

stop_stack() {
  log "Stopping HIEF stack..."
  cd "$ROOT_DIR"
  docker compose down
  ok "Stack stopped"
}

# ── Main ──────────────────────────────────────────────────────────────────────
print_banner

case "$MODE" in
  --local)
    check_deps
    check_env
    start_local
    ;;
  --testnet)
    check_deps
    check_env
    start_testnet
    ;;
  --stop)
    stop_stack
    ;;
  --help | -h)
    echo "Usage: $0 [--local | --testnet | --stop | --help]"
    echo ""
    echo "  --local    Start with mock/local config (default)"
    echo "  --testnet  Start connected to Base Sepolia (requires .env)"
    echo "  --stop     Stop all services"
    echo "  --help     Show this help"
    ;;
  *)
    err "Unknown option: $MODE. Use --help for usage."
    ;;
esac
