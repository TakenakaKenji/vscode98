#!/usr/bin/env bash
# Re-runs the Web API / CSS / language-feature file counts used in docs98/inventory.
# Usage (from repo root):  bash docs98/inventory/scripts/scan_web_and_lang.sh
# Counts are FILES in src/vs (non-test) matching a regex. They over-approximate (see inventory/README.md).
cnt(){ printf "%-52s" "$1"; grep -rlE -e "$1" src/vs --include=*.ts --exclude-dir=test | wc -l; }
c(){ printf "%-44s" "$1"; find src/vs -name '*.css' -not -path '*/test/*' -print0 | xargs -0 grep -lE -e "$1" | wc -l; }
echo "== Web APIs =="
for a in "new Worker\(|new SharedWorker" "MessageChannel|MessagePort" "ResizeObserver" "IntersectionObserver" "MutationObserver" "requestAnimationFrame" "getContext\('2d'|getContext\(\"2d\"" "webgl|webgpu" "OffscreenCanvas" "attachShadow|ShadowRoot" "customElements" "indexedDB|IndexedDB" "localStorage|sessionStorage" "\bfetch\(" "new WebSocket" "TextDecoder|TextEncoder" "navigator\.clipboard|ClipboardEvent|clipboardData" "DragEvent|dataTransfer" "contentEditable|contenteditable|EditContext" "WebAssembly" "getComputedStyle" "getBoundingClientRect" "matchMedia" "Trusted(Types|HTML)|trustedTypes" "PointerEvent|setPointerCapture" "ReadableStream|WritableStream|TransformStream" "AbortController" "BroadcastChannel" "WeakRef|FinalizationRegistry"; do cnt "$a"; done
echo "== CSS (471 files at 32bbe1b8) =="
for a in "display:\s*flex|display:\s*inline-flex" "display:\s*grid|grid-template" "var\(--" "calc\(" "position:\s*sticky" "transform:|translate|rotate|scale\(" "transition:|animation:|@keyframes" "@media" "@container|container-type" ":has\(" ":is\(|:where\(|:not\(" "::before|::after" "::-webkit-scrollbar|scrollbar-" "backdrop-filter|filter:" "box-shadow" "border-radius" "linear-gradient|radial-gradient" "-webkit-" "mask|clip-path" "color-mix|oklch|lab\(" "@layer|@scope|@supports" "@font-face"; do c "$a"; done
echo "== Language features =="
for a in "\?\.[A-Za-z_\[(]" " \?\? " "^\s*(static )?#[a-zA-Z_]+" "\bBigInt\b" "function\s*\*" "for await" "new Proxy\(" "\(\?<[=!]" "\(\?<[A-Za-z]" "Intl\.Segmenter" "Promise\.(allSettled|any|withResolvers)" "\.(at|findLast|toSorted|flatMap|fromEntries)\("; do cnt "$a"; done
