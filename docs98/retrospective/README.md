# Retrospective and roadmap: getting VS Code off Electron

**Written 2026-10-16, after spike 13 and package v15.** What was built, in what order, what went wrong and how it was corrected, what worked, and a guide for doing the same to another Electron app. The spike READMEs remain the detailed record; this folder is the map and the lessons.

## Contents

| Part | For |
|---|---|
| [1 — Timeline](01-timeline.md) | How we got here: Phase 0 inventory, spikes 1 to 13, the ten real-Windows rounds, the control benchmark, the native style engine; where we are now. |
| [2 — Mistakes, misses and corrections](02-mistakes-and-corrections.md) | Every error that cost real time, grouped (measuring, wrong hypotheses, packaging, Wine, missing semantics, engine bugs, tool slips, scope), each with root cause, fix and rule. |
| [3 — What worked](03-what-worked.md) | Techniques to reuse: one question per spike, oracles and verify modes, recording stubs, keeping the app unmodified, the style-system order of work, debugging tools, scenario rigs, the control benchmark, working with a remote owner. |
| [4 — Playbook: moving an Electron app off Electron](04-porting-playbook.md) | A rough step-by-step guide for the next app, with the shorter path where we took the long one. |
| [5 — Working practices](05-working-practices.md) | Concrete rules for running this project day to day (measuring, correctness, debugging, the cloud container, packaging, talking to the owner). **Read before starting work.** |

## The story in one paragraph

On 2026-10-11 the project was a fork of VS Code 1.142 and a set of runtime traces of what it uses from Chromium, Node and Electron. In one long day, eleven feasibility spikes showed each piece could be replaced: QuickJS-ng for V8, Node shims plus a small C process layer for Node, VS Code's own main process on a ~190-line `electron` stub for Electron, a self-written DOM/CSS/layout/painter (layout and raster in C, checked byte for byte) for Chromium, and a mingw-w64 i586 Windows host with a GDI window. Ten rounds on a real Windows 7 VM and laptop then turned "it boots" into "it works": fonts, input, Enter, shortcuts, menus, text controls, terminal, webviews, images, syntax highlighting, IPC stalls. Performance lagged, and v12 was "unusable". The owner asked for a control against stock VS Code on the same machine. Spike 12 showed we were 3 to 23 times slower per interaction, with style computation at 65 to 87 % of the time. Spike 13 moved selector matching to C and fixed the costliest JavaScript in the computed-value step. Interactions became 1.6 to 4.4 times faster, now 2.4 to 8.6 times Electron, with identical output. Along the way it found and fixed a long-standing random exit of the Linux host (poll `EINTR`).

## Ten rules that would have saved the most time

1. **Build the control benchmark (stock app, same machine, same actions) with the first runnable build** and report the ratio every round. (A1)
2. **Profile before you name or port a bottleneck.** (A2: layout was ported; style was the cost.)
3. **Never retry around a flake.** Get a stack of the exit, instrument the event loop, find the cause. (B2: poll `EINTR`, days lost.)
4. **Trace end to end before hypothesising; write down what would refute each hypothesis; revert the changes that did not fix it.** (B1)
5. **Every optimisation needs an oracle**: identical output, a verify mode, a fuzzer. Then optimise aggressively.
6. **Keep the app unmodified; replace the platform under it**: recording stubs to size the API, stand-ins for native addons, the real main process on an `electron` stub.
7. **Match the reference runtime's semantics, not just its API list**: error routing in timers and microtasks, signals, `EventEmitter` details, unhandled rejections, `error.stack`.
8. **Test the package on the real target**; Wine and the dev tree hide fonts, heap and timer behaviour, and missing modules.
9. **Cut out-of-scope features before measuring** (the AI UI was half the boot).
10. **Commit and push after every verified step, and keep the docs current** (decisions, roadmap, checkpoint): the container can restart, and stale docs mislead the next session.

## Current state and next steps

See [CHECKPOINT.md](../CHECKPOINT.md) for the live status. In short: package v15 is with the owner. The next performance targets are the cold first style pass at startup (~2.5 s on the sandbox, almost all building the index of 13,296 rules; candidate: a prebuilt, cached index) and computed style values in C (phase 2 of spike 13). Functional gaps are in [FEATURES.md](../FEATURES.md).
