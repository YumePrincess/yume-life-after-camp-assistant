#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MAC_DIR="${SCRIPT_DIR:h}"
OUTPUT_DIR="${MAC_DIR}/bin"

mkdir -p "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}/module-cache"
xcrun swiftc \
  -O \
  -module-cache-path "${OUTPUT_DIR}/module-cache" \
  -framework Vision \
  -framework CoreGraphics \
  -framework ImageIO \
  "${MAC_DIR}/vision/MrzhVisionOCR.swift" \
  -o "${OUTPUT_DIR}/mrzh-vision-ocr"

xcrun swiftc \
  -O \
  -module-cache-path "${OUTPUT_DIR}/module-cache" \
  -framework CoreGraphics \
  -framework ImageIO \
  "${MAC_DIR}/vision/MrzhPixelProbe.swift" \
  -o "${OUTPUT_DIR}/mrzh-pixel-probe"

echo "Built ${OUTPUT_DIR}/mrzh-vision-ocr and ${OUTPUT_DIR}/mrzh-pixel-probe"
