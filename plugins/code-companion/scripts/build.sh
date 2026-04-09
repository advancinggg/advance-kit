#!/bin/bash
# Build Code Companion macOS app from Swift source.
# Usage: ./build.sh [--output /path/to/binary]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${SCRIPT_DIR}/../app"
OUTPUT="${1:-${APP_DIR}/code-companion}"

# Shift past --output flag if present
if [[ "${1:-}" == "--output" ]]; then
    OUTPUT="${2:?--output requires a path}"
fi

echo "Building Code Companion..."

# Check prerequisites
if ! command -v swiftc &>/dev/null; then
    echo "Error: swiftc not found. Install Xcode Command Line Tools:" >&2
    echo "  xcode-select --install" >&2
    exit 1
fi

SDK_PATH=$(xcrun --show-sdk-path 2>/dev/null)
if [[ -z "$SDK_PATH" ]]; then
    echo "Error: macOS SDK not found." >&2
    exit 1
fi

swiftc \
    -sdk "$SDK_PATH" \
    -framework AppKit \
    -framework SwiftUI \
    -framework Network \
    -O \
    -o "$OUTPUT" \
    "${APP_DIR}/main.swift"

echo "Built: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
