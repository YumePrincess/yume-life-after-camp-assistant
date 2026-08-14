#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MAC_DIR="${SCRIPT_DIR:h}"
OUTPUT_DIR="${MAC_DIR}/bin"
MODULE_CACHE_DIR="${YLA_VISION_MODULE_CACHE_DIR:-/private/tmp/yla-vision-module-cache}"

mkdir -p "${OUTPUT_DIR}"
mkdir -p "${MODULE_CACHE_DIR}"
xcrun swiftc \
  -O \
  -parse-as-library \
  -module-cache-path "${MODULE_CACHE_DIR}" \
  -framework Vision \
  -framework CoreML \
  -framework CoreGraphics \
  -framework CoreVideo \
  -framework ImageIO \
  "${MAC_DIR}/vision/MrzhVisionOCR.swift" \
  "${MAC_DIR}/vision/MrzhSymbolClassifier.swift" \
  -o "${OUTPUT_DIR}/mrzh-vision-ocr"

xcrun swiftc \
  -O \
  -module-cache-path "${MODULE_CACHE_DIR}" \
  -framework CoreGraphics \
  -framework ImageIO \
  "${MAC_DIR}/vision/MrzhPixelProbe.swift" \
  -o "${OUTPUT_DIR}/mrzh-pixel-probe"

echo "Built ${OUTPUT_DIR}/mrzh-vision-ocr and ${OUTPUT_DIR}/mrzh-pixel-probe"
