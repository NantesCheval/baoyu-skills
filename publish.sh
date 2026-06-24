#!/usr/bin/env bash
# 一键发布微信公众号草稿
# 用法: ./publish.sh <md路径> "标题" "摘要" [主题]
# 例:   ./publish.sh skills/post-to-wechat/zhoukou.md "周口" "摘要" default
set -euo pipefail

MD="${1:?需要 md 路径}"
TITLE="${2:?需要标题}"
SUMMARY="${3:?需要摘要}"
THEME="${4:-default}"

cd "$(dirname "$0")"
HTML="${MD%.md}.html"

# 本机 bun，不走 npx -y（省去联网拉最新版的 ~3s/次）
BUN="$(command -v bun)"

echo "[1/2] MD -> HTML ($THEME)"
"$BUN" skills/baoyu-markdown-to-html/scripts/main.ts "$MD" --theme "$THEME" >/dev/null

echo "[2/2] 发布草稿"
"$BUN" skills/baoyu-post-to-wechat/scripts/wechat-article.ts \
  --html "$HTML" --title "$TITLE" --summary "$SUMMARY"

echo "完成：草稿已存。去后台补封面图即可群发。"
