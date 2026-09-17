#!/bin/sh
# Download DeepSeek's tokenizer so token counts are exact instead of estimated.
#
#   sh scripts/fetch-tokenizer.sh [target-directory]
#
# The files come from the official DeepSeek-V3.2-Exp repository on Hugging Face.
# DeepSeek-V3.1 ships the byte-identical tokenizer.json, and both back the
# `deepseek-chat` and `deepseek-reasoner` API models. The download is checked
# against a pinned SHA-256, so a changed or truncated file is never used.
set -eu

TARGET=${1:-"$(dirname "$0")/../vendor/deepseek-tokenizer"}
BASE=https://huggingface.co/deepseek-ai/DeepSeek-V3.2-Exp/resolve/main
TOKENIZER_SHA256=32b34a41212e92f62e859cbbea121ae705a1fabbf157d9acf22d134ecd8dcf70

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

mkdir -p "$TARGET"
if [ -f "$TARGET/tokenizer.json" ] && [ "$(sha256 "$TARGET/tokenizer.json")" = "$TOKENIZER_SHA256" ] \
  && [ -s "$TARGET/tokenizer_config.json" ]; then
  echo "Tokenizer already present in $TARGET"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading DeepSeek tokenizer (~8 MB)..."
curl -fsSL --retry 3 --max-time 300 -o "$TMP/tokenizer.json" "$BASE/tokenizer.json"
curl -fsSL --retry 3 --max-time 60 -o "$TMP/tokenizer_config.json" "$BASE/tokenizer_config.json"

ACTUAL=$(sha256 "$TMP/tokenizer.json")
if [ "$ACTUAL" != "$TOKENIZER_SHA256" ]; then
  echo "Checksum mismatch for tokenizer.json (got $ACTUAL). Not installing it." >&2
  exit 1
fi

mv "$TMP/tokenizer.json" "$TMP/tokenizer_config.json" "$TARGET/"
echo "Installed tokenizer into $TARGET"
