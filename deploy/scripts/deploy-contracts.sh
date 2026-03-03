#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIEF Contract Deployment Script
# Deploys ReputationNFT to Base Sepolia (or local Anvil fork)
#
# Usage:
#   ./deploy/scripts/deploy-contracts.sh [--local | --testnet | --dry-run]
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTRACT_DIR="$ROOT_DIR/contracts/reputation"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${BLUE}[deploy]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; exit 1; }

MODE="${1:---dry-run}"

# Check forge
command -v forge >/dev/null 2>&1 || {
  warn "forge not found. Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  source ~/.bashrc
  foundryup
}

# Load .env
if [ -f "$ROOT_DIR/.env" ]; then
  set -a; source "$ROOT_DIR/.env"; set +a
  ok "Loaded .env"
else
  warn ".env not found — using environment variables only"
fi

cd "$CONTRACT_DIR"

case "$MODE" in
  --local)
    log "Deploying to local Anvil fork (port 8545)..."
    log "Make sure Anvil is running: anvil --fork-url \$BASE_SEPOLIA_RPC_URL --port 8545"
    echo ""

    forge script script/DeployLocal.s.sol \
      --rpc-url http://localhost:8545 \
      --broadcast \
      -vvvv

    ok "Local deployment complete!"
    ;;

  --testnet)
    log "Deploying to Base Sepolia..."

    [ -z "${DEPLOYER_PRIVATE_KEY:-}" ] && err "DEPLOYER_PRIVATE_KEY is required"
    [ -z "${BASE_SEPOLIA_RPC_URL:-}"  ] && err "BASE_SEPOLIA_RPC_URL is required"

    warn "This will broadcast a real transaction on Base Sepolia."
    read -p "Continue? (y/N) " confirm
    [ "$confirm" != "y" ] && [ "$confirm" != "Y" ] && { log "Aborted."; exit 0; }

    VERIFY_FLAGS=""
    if [ -n "${BASESCAN_API_KEY:-}" ]; then
      VERIFY_FLAGS="--verify --etherscan-api-key $BASESCAN_API_KEY"
      log "Contract verification enabled (Basescan)"
    else
      warn "BASESCAN_API_KEY not set — skipping verification"
    fi

    forge script script/DeployReputationNFT.s.sol \
      --rpc-url "$BASE_SEPOLIA_RPC_URL" \
      --broadcast \
      $VERIFY_FLAGS \
      -vvvv

    ok "Testnet deployment complete!"
    warn "Copy the REPUTATION_NFT_ADDRESS from the output above into your .env file"
    ;;

  --dry-run)
    log "Dry run — simulating deployment (no broadcast)..."

    [ -z "${BASE_SEPOLIA_RPC_URL:-}" ] && {
      warn "BASE_SEPOLIA_RPC_URL not set — using mock simulation"
      # Use a dummy key for dry run
      export DEPLOYER_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
      forge script script/DeployLocal.s.sol \
        --rpc-url http://localhost:8545 \
        -vvvv 2>&1 | head -40 || true
      warn "Note: Start Anvil locally for a full dry run simulation"
      exit 0
    }

    forge script script/DeployReputationNFT.s.sol \
      --rpc-url "$BASE_SEPOLIA_RPC_URL" \
      -vvvv

    ok "Dry run complete — no transactions broadcast"
    ;;

  --help | -h)
    echo "Usage: $0 [--local | --testnet | --dry-run]"
    echo ""
    echo "  --local    Deploy to local Anvil fork (default port 8545)"
    echo "  --testnet  Deploy to Base Sepolia (requires DEPLOYER_PRIVATE_KEY)"
    echo "  --dry-run  Simulate deployment without broadcasting (default)"
    ;;

  *)
    err "Unknown option: $MODE. Use --help for usage."
    ;;
esac
