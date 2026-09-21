#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
MAC_DIR="${SCRIPT_DIR:h}"
OUTPUT_DIR="${MAC_DIR}/bin"

mkdir -p "${OUTPUT_DIR}"
mkdir -p "${OUTPUT_DIR}/module-cache"
xcrun swiftc \
  -O \
  -parse-as-library \
  -module-cache-path "${OUTPUT_DIR}/module-cache" \
  -framework Vision \
  -framework CoreGraphics \
  -framework CoreVideo \
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

xcrun swiftc \
  -O \
  -module-cache-path "${OUTPUT_DIR}/module-cache" \
  -framework CoreGraphics \
  -framework ImageIO \
  "${MAC_DIR}/vision/MrzhImageMask.swift" \
  -o "${OUTPUT_DIR}/mrzh-image-mask"

echo "Built ${OUTPUT_DIR}/mrzh-vision-ocr, ${OUTPUT_DIR}/mrzh-pixel-probe and ${OUTPUT_DIR}/mrzh-image-mask"
