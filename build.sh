#!/usr/bin/env bash
set -euo pipefail

# Build script for Суфлёр.app (macOS)
APP_NAME="Суфлёр.app"
BUILD_DIR="build"
OUTPUT_APP="$BUILD_DIR/$APP_NAME"

echo "==> Подготовка сборочной директории..."
rm -rf "$BUILD_DIR"
mkdir -p "$OUTPUT_APP/Contents/MacOS"
mkdir -p "$OUTPUT_APP/Contents/Resources/suflyor"

echo "==> Компиляция нативной оболочки Suflyor (Swift)..."
swiftc -O Suflyor.swift -o "$OUTPUT_APP/Contents/MacOS/Suflyor" \
  -framework Cocoa -framework WebKit -framework Speech -framework AVFoundation

echo "==> Копирование ресурсов..."
cp Info.plist "$OUTPUT_APP/Contents/Info.plist"
cp AppIcon.icns "$OUTPUT_APP/Contents/Resources/AppIcon.icns"
cp -R suflyor/* "$OUTPUT_APP/Contents/Resources/suflyor/"

# Удаление временных файлов питона, если попали
find "$OUTPUT_APP" -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
find "$OUTPUT_APP" -name "*.pyc" -delete 2>/dev/null || true

echo "==> Подпись приложения локальным ad-hoc сертификатом..."
codesign --force --deep --sign - "$OUTPUT_APP"

echo "==> Сборка завершена: $OUTPUT_APP"

if [[ "${1:-}" == "--dmg" ]]; then
  DMG_NAME="Суфлёр.dmg"
  echo "==> Создание $DMG_NAME..."
  STAGE="/tmp/suflyor_dmg_stage_$$"
  rm -rf "$STAGE" "$DMG_NAME"
  mkdir -p "$STAGE"
  ditto "$OUTPUT_APP" "$STAGE/$APP_NAME"
  ln -s /Applications "$STAGE/Программы"
  cat << 'EOF' > "$STAGE/Как_запустить.txt"
Суфлёр 9:16 Studio — памятка для первого запуска

1. Перетащи «Суфлёр» в папку «Программы» (Applications).
2. При первом запуске macOS может предупредить о неизвестном разработчике:
   нажми правой кнопкой мыши по «Суфлёр» -> «Открыть» -> «Открыть».
3. Разреши программе доступ к Камере, Микрофону и Распознаванию речи.
4. Для автоматической нарезки и сохранения видео в 9:16 (1080x1920) нужен ffmpeg:
   brew install ffmpeg
5. Готовые ролики сохраняются в папку: ~/Movies/Суфлёр
EOF
  hdiutil create -volname "Суфлёр 9x16 Studio" -srcfolder "$STAGE" -ov -format UDZO "$DMG_NAME"
  rm -rf "$STAGE"
  echo "==> Готово: $DMG_NAME"
fi
