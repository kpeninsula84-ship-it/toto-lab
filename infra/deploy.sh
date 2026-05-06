#!/usr/bin/env bash
#
# Reference copy of /root/deploy.sh on the production VPS (Contabo).
# This script is multi-tenant — it serves toto-lab, ai-debate, and
# my-life-os from the same VPS. It lives at /root/deploy.sh on the host;
# this copy is for visibility and review.
#
# When edited: copy to the VPS, do NOT rely on git pull for sync.
#   scp infra/deploy.sh root@<vps>:/root/deploy.sh
#
# Invoked by .github/workflows/deploy.yml as:
#   /root/deploy.sh toto-lab

set -euo pipefail

TARGET="${1:-}"

usage() {
    echo "Usage: $0 {ai-debate|toto-lab|my-life-os|all}"
    exit 1
}

# Print only files that changed between two refs
changed_files() {
    local before="$1"
    local after="$2"
    if [ "$before" = "$after" ]; then
        return 0
    fi
    git diff --name-only "$before" "$after"
}

deploy_ai_debate() {
    echo "=== [ai-debate] 배포 시작 ==="
    cd /root/ai-debate

    local before after changed
    before=$(git rev-parse HEAD)
    git pull
    after=$(git rev-parse HEAD)
    changed=$(changed_files "$before" "$after")

    if echo "$changed" | grep -qx 'package.json'; then
        echo "[ai-debate] package.json 변경 → npm install"
        npm install
    fi

    if echo "$changed" | grep -qx 'client/package.json'; then
        echo "[ai-debate] client/package.json 변경 → npm install (client)"
        (cd client && npm install)
    fi

    echo "[ai-debate] npm run build"
    npm run build

    echo "[ai-debate] systemctl restart"
    sudo systemctl restart ai-debate

    sleep 5

    if sudo systemctl is-active --quiet ai-debate; then
        echo "✅ [ai-debate] active"
    else
        echo "❌ [ai-debate] not active"
        sudo systemctl status ai-debate --no-pager -n 20
        return 1
    fi
}

deploy_toto_lab() {
    echo "=== [toto-lab] 배포 시작 ==="
    cd /root/toto-lab

    local before after changed
    before=$(git rev-parse HEAD)
    git pull
    after=$(git rev-parse HEAD)
    changed=$(changed_files "$before" "$after")

    if echo "$changed" | grep -qx 'functions/package.json'; then
        echo "[toto-lab] functions/package.json 변경 → npm install (functions)"
        (cd functions && npm install)
    fi

    if echo "$changed" | grep -qx 'worker/package.json'; then
        echo "[toto-lab] worker/package.json 변경 → npm install (worker)"
        (cd worker && npm install)
    fi

    echo "[toto-lab] firebase deploy"
    if [ -r /root/.firebase_token ]; then
        export FIREBASE_TOKEN
        FIREBASE_TOKEN="$(cat /root/.firebase_token)"
    fi

    if firebase --config /root/toto-lab/firebase.json deploy --non-interactive; then
        echo "✅ [toto-lab] deploy 성공"
    else
        echo "❌ [toto-lab] deploy 실패"
        return 1
    fi
}

deploy_my_life_os() {
    echo "=== [my-life-os] 배포 시작 ==="
    cd /root/my-life-os

    local before after changed
    before=$(git rev-parse HEAD)
    git pull
    after=$(git rev-parse HEAD)
    changed=$(changed_files "$before" "$after")

    if echo "$changed" | grep -qx 'bot/package-lock.json'; then
        echo "[my-life-os] bot/package-lock.json 변경 → npm ci (bot)"
        (cd bot && npm ci)
    fi

    echo "[my-life-os] systemctl restart"
    sudo systemctl restart my-life-os-bot

    sleep 5

    if sudo systemctl is-active --quiet my-life-os-bot; then
        echo "✅ [my-life-os] active"
    else
        echo "❌ [my-life-os] not active"
        sudo systemctl status my-life-os-bot --no-pager -n 20
        return 1
    fi
}

case "$TARGET" in
    ai-debate)
        deploy_ai_debate
        ;;
    toto-lab)
        deploy_toto_lab
        ;;
    my-life-os)
        deploy_my_life_os
        ;;
    all)
        deploy_ai_debate
        deploy_toto_lab
        deploy_my_life_os
        ;;
    *)
        usage
        ;;
esac
