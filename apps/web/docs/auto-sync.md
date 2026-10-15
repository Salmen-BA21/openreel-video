# Auto Sync a clip to reference audio

Auto Sync measures where a video clip starts on a reference recording's timeline by cross-correlating audio envelopes, then aligns the clip — delaying it or trimming its head — so its audio matches the reference. Typical use: music plays on speakers, a phone records the performance, and the clean track is the reference.

## How to use

### Quick flow — toolbar button (one click, Filmora-style)

1. Put the clean reference audio on the timeline (skip this if it is already there), then select **both** clips — the video clip and the audio clip — with Ctrl+click (Shift+click and marquee selection work too).
2. Click **Auto Synchronization** in the timeline toolbar (waveform icon). The button lights up only when exactly one video and one audio clip are selected; a spinner shows while it runs.
3. The clip is analyzed and aligned in one step. A toast reports the offset and match score; undo the whole alignment with Ctrl+Z. If the match is too weak or something is in the way, the toast explains why and nothing is changed.

### Detailed flow — inspector section

1. Select a video clip on the timeline and open **Audio → Auto Sync**.
2. Pick the reference source:
   - **Timeline audio clip** — a music or voice clip already on the timeline (choose it from the list; the only audio clip is preselected).
   - **Audio file** — a wav/mp3 file from your computer (**Choose file**).
3. Choose **Analyze**. Progress appears while the audio is decoded and correlated; the offset and match score are shown when it finishes.
4. Choose **Apply** to align the clip. Undo the whole alignment with Ctrl+Z.

Changing the reference or the clip's trim invalidates the result — analyze again before applying. Both flows share the same engine, options, and undo group.

## Reading the result

- **Offset** — where the clip starts on the reference timeline, in seconds:
  - **Positive** — the clip started after the reference began → **Apply delays the clip** by that amount.
  - **Negative** — the clip started before the reference (its head contains audio the reference does not have) → **Apply trims that many seconds from the clip's head**.
- **Match score** — a raw normalized cross-correlation value, not a 0–1 percentage. Apply is only offered when the score is above the 0.32 match threshold; a lower score means the reference probably does not contain this clip's audio (wrong file, silent clip, heavy voice-over).
- With a **timeline reference**, the clip is placed at the reference clip's start plus the offset (negative offsets land it exactly on the reference's start after trimming). With a **file reference**, the file is treated as starting where the clip currently is, so a positive offset delays the clip in place and a negative one trims it in place.

## Requirements and limits

- One clip per run — syncing several clips in a batch is not supported yet.
- The clip and the reference each need at least 1 second of audio.
- Reset speed changes, reverse playback, and freeze frames before analyzing.
- wav/mp3 files decode natively; other formats go through the built-in audio converter and may fail.
- Analysis runs on the main thread, so long recordings can pause the interface for a few seconds.
- The reference must be the same recording as the clip's audio (a different take or song will score below the threshold).

## How it works

- Engine: `packages/core/src/sync/auto-sync-engine.ts` (pure TypeScript, no dependencies).
- Bridge: `apps/web/src/bridges/auto-sync-bridge.ts` (decodes audio, runs phases, applies the offset through the store's undo-grouped `trimClip`/`moveClip`; `syncPair()` powers the one-click toolbar button).
- UI: `apps/web/src/components/editor/inspector/AutoSyncSection.tsx`, shown in the Audio tab for video clips, and the **Auto Synchronization** button in the timeline toolbar (`apps/web/src/components/editor/Timeline.tsx`).

Pipeline: downmix to mono → resample to 16 kHz → 1 kHz envelope (analytic magnitude with a 35 Hz IIR low-pass, z-scored) → normalized cross-correlation of both envelopes with an 80 % overlap guard → offset = lag of the first maximum. The exact-length DFT uses Bluestein's algorithm on top of the package's radix-2 FFT so arbitrary lengths match the reference implementation.

All numeric constants (16 kHz analysis rate, 1 ms envelope stride, IIR coefficients, 0.32 score threshold, 0.8 overlap guard) were recovered by static analysis of Wondershare Filmora 15's auto-sync binary by the upstream project — see "Credits and license".

## Verification

- Synthetic parity tests ported from the reference suite: `packages/core/src/sync/auto-sync-engine.test.ts` (offsets recovered within 10–20 ms) — run with `pnpm --filter @openreel/core test:run`.
- Bridge and UI tests: `apps/web/src/bridges/auto-sync-bridge.test.ts`, `apps/web/src/components/editor/inspector/AutoSyncSection.test.tsx`.
- **TS-vs-Python cross-check on real pairs**: `packages/core/src/sync/auto-sync-crosscheck.test.ts` is gated on the `AUTO_SYNC_PAIRS` environment variable and skipped otherwise. It decodes the WAV files, runs the TS engine, and compares each offset with the value Python's `sync_ref.py` reported for the same pair (10 ms tolerance). Pairs are `reference.wav|camera.wav|python-offset`, separated by `;`:

  ```powershell
  # 1) extract the camera audio losslessly (ffmpeg, or the av module you already have)
  ffmpeg -i camera.MOV -c:a pcm_s16le camera.wav

  # 2) run the cross-check (PowerShell)
  $env:AUTO_SYNC_PAIRS = "C:/media/clean.wav|C:/media/camera.wav|-0.461;C:/media/clean2.wav|C:/media/camera2.wav|-0.583"
  pnpm --filter @openreel/core exec vitest run src/sync/auto-sync-crosscheck.test.ts
  ```

  On bash/zsh, prefix the command instead: `AUTO_SYNC_PAIRS="..." pnpm --filter @openreel/core exec vitest run src/sync/auto-sync-crosscheck.test.ts`. Media files stay outside the repository; only the paths are passed in.

## Credits and license

Ported from **filmora-auto-sync** by Salmen Ben Ammar, MIT licensed. The algorithm and its constants were recovered by static (Ghidra) analysis of Filmora 15's `magic_xe_audio_synchronization_v4.dll`; the upstream `SPEC.md` documents the evidence, and this implementation keeps the same pipeline, constants, score threshold, and output semantics (with the documented deviations noted in the engine source).

**Not affiliated with Wondershare.** Filmora is a trademark of Wondershare. This is an independent reimplementation that uses no Filmora code, performs no license/DRM interaction, and is intended for timing analysis of your own recordings.
