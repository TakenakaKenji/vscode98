# 5 — Working practices (how to run this project without repeating old mistakes)

Concrete rules from the sessions so far. Each one exists because ignoring it cost time at least once (the incident is in brackets; details in [02-mistakes-and-corrections.md](02-mistakes-and-corrections.md)).

## Measuring

1. **Have an external baseline before optimising.** Measure the thing the user compares against (stock Electron VS Code on the same machine) with the same actions and the same CPU limit, and keep re-running it. Internal before/after numbers can all improve while the product is still far behind or getting worse. [v12 was called "unusable" while internal numbers looked fine; spike 12 was only built after the owner insisted.]
1b. **For startup, measure the critical path, not a phase.** A phase's CPU time (style, index) only shortens the launch if the launch waits on it; take a timeline of all processes (busy vs waiting) first. [v18 removed 2.6 s of renderer CPU and the laptop's launch did not change.]
2. **Time from the input event to the visible result**, per action, median of ≥ 3 rounds (5 for anything you will quote), with a split of where the time went (`scenario_ctl.mjs --split 1`: event / frames / style / layout / paint). An action that "takes 1 s" on the laptop is decomposed before anything is changed.
3. **Pin CPUs and never benchmark while something else runs.** `taskset -c 0-1` for both contenders. A test suite in the background, a leftover Electron instance or a Wine session doubles some numbers and not others. [Startup index profile and restyle timings were noisy while the scenario suite ran.]
4. **Profile with a copy, not with the repo.** `/tmp/claude-0/mkprof.py` copies the spike sources and adds phase timers; the repo never carries instrumentation that could be committed by accident. Same for `--restyle N` style microbenchmarks on the captured workbench (`run_replay_qjs.mjs /tmp/claude-0/workbench.json --restyle 5`).
5. **The sandbox is ~2.4 to 3.4 times faster than the owner's Windows 7 laptop** for our engine. Quote laptop expectations from that, and say they are estimates.
5b. **The sandbox machine can change between sessions** (2026-10-16: a 2.8 GHz Xeon replaced the 2.1 GHz one after a container restart, and QuickJS ran relatively slower on it). Check `/proc/cpuinfo` at the start of a performance session, never compare absolute numbers across sessions, and measure A/B on the same machine the same day: the previous engine (`--style match`, `--style js`, `--layout js`) and stock Electron re-run there (with its own `HOME`).

## Correctness

6. **Every optimisation of the engine has an oracle.** Identical output to the previous implementation (layout dump + framebuffer, `cmp`), a verify mode that runs both paths on every element (`--style verify`), and the randomised fuzz (`09-incremental-style/tests/style_fuzz.mjs`, `FUZZ_NATIVE=1` for the C matcher). "Looks right in a screenshot" is not a check.
7. **When the oracle reports a difference, find out which side is wrong before fixing.** The `:focus-within` "bug" of the native matcher was the fuzz test's reset bypassing `removeChild` (the old tree kept `parentNode` links), not the matcher.
8. **Run the feature scenarios after every engine change** (`/tmp/claude-0/runall_v.sh native`: 11 scenarios, PASS/FAIL plus the native style report). They take ~45 minutes; start them in the background and do something CPU-light meanwhile.

## Debugging

9. **Root-cause flakes; never retry around them.** "main process exited: code 0" was retried for days. It was QuickJS-ng ending its event loop on `poll()` → `EINTR` (a `SIGCHLD`). Finding it took: a C stack of `exit_group` (`strace -f --seccomp-bpf -k -e trace=exit_group`: near-zero overhead, so the race still happens), then a debug build of `quickjs-libc.c` that prints *why* `js_std_loop` returned. Do that first next time.
10. **Write down each hypothesis and the observation that would refute it, then check that observation before changing code.** Wrong hypotheses tried for the main-process exit: SQLite shared storage written by the Electron run, an empty event loop (a keep-alive timer did not help), exceptions in timers (a real bug, but not this one), stream backpressure. For the Windows new-file stall: handle overflow, stderr spam, stream backpressure, handler exceptions, before the real cause (the overlapped write queue was flushed only by the next write).
11. **Revert the fixes that did not fix it** unless they are independently correct (and then say so in the commit). The backpressure change of round 10 was reverted the same evening; the timer-exception routing was kept on its own merits.
12. **Trace switches exist; use them before guessing:** `--debug-ipc 1` (renderer send/receive with timestamps), `VSCODE98_TRACE_IPC=1` (main stub IN/OUT into `ELECTRON_STUB_LOG`), `UTIL_TRACE`, `VSCODE98_TRACE_PIPE` (every IPC line), `--echo-main 1` (main's stdout/stderr live). Remember the harness only prints the main's output at the end unless `--echo-main 1` is given.

## Environment (Claude Code cloud container)

13. **Commit and push early.** The container can restart at any time (it did, mid-profile): background tasks die, `/tmp` usually survives, uncommitted work in the repo survives but is at risk. Commit after each verified step.
14. **Never `pkill -f <pattern>`**: it matched and killed the shell running it (exit 144). Use `pkill -x qjs-spike7`.
15. **Clean up after the Electron control runs**: kill `code-oss` (`pkill -9 -x code-oss`), and move `~/.vscode-oss-shared/sharedStorage/state.vscdb*` aside; our host uses the same product data folder and inherited a real SQLite database from it.
16. **Wine:** fresh Xvfb (`-ac`) per run, stop `wineserver -k` gracefully, fresh prefix if `CreateWindow` fails with 1400 (`/tmp/claude-0/wrun.sh`, `wrun15.sh`). Wine is a smoke test only: real Windows 7 found what Wine hid (Linux font paths that Wine resolved, raw `EEXIST` from `mkdir`, a file reader that is quadratic on the Windows heap, the 15.6 ms timer tick, an empty keymap, an idle `WM_PAINT` repaint loop).
17. **Destructive commands with a glob after `cd` are refused** by the harness safety check; use absolute paths without globs.
18. Long-running commands: `--seconds 900` for long scenarios (a `--seconds 120` limit once killed a run mid-way and looked like a crash).

## Packaging for the owner

19. **The package is a product; test the package, not the tree.** Boot it under Wine from the unpacked folder before sending (`wrun15.sh qjs-win-x86.exe --style verify`). [v12 had no syntax highlighting because `vscode-textmate` was not in `needmods.txt`; the tree had it.]
20. Zip the `vscode98-win-desktop` folder, `split -b 14M -d -a 1` into `.partN`, a `join-parts.cmd` that joins and prints the SHA256, report the SHA256 in the message. Remove `userdata/` and `results/` from the package dir first.
21. **Ask for the same measurements each round** (load time, file open, caret, double click, switch file, menu open/move, new file/folder, plus any functional failures) so rounds are comparable; record them in `11-windows-host/README.md` under a new round.

## Talking to the owner

22. Give numbers with their conditions (sandbox or laptop, CPUs, rounds), say what was not measured, and separate "fixed and verified" from "expected".
23. When the owner reports a regression, believe it first and measure it; when the owner proposes a better method (the control benchmark), adopt it.
