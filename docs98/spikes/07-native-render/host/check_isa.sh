#!/usr/bin/env bash
# Static check that a binary only uses the Pentium (i586) instruction set: no SSE/SSE2 (xmm registers, sse mnemonics), no MMX (mm registers), no CMOV (Pentium Pro and later).
# Usage: check_isa.sh <binary>   (exit 1 when a post-i586 instruction is found)
set -uo pipefail
BIN=${1:?binary}; DIS=$(objdump -d --no-show-raw-insn "$BIN")
count() { echo "$DIS" | grep -c -E "$1"; }
XMM=$(count '%xmm'); MMX=$(count '%mm[0-7]'); CMOV=$(count '\bcmov'); SSEOP=$(count '\b(movaps|movups|movss|movsd|cvtsi2sd|cvttsd2si|sqrtsd|ucomisd|comisd|pxor|movdqa|movdqu|paddd|emms)\b')
echo "$BIN: xmm=$XMM mmx=$MMX cmov=$CMOV sse-mnemonics=$SSEOP"
[ "$XMM$MMX$CMOV$SSEOP" = "0000" ] && echo "OK: i586 / x87 only" || { echo "FAIL: instructions newer than the Pentium found"; exit 1; }
