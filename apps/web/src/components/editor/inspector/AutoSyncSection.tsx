import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Loader2,
  Music,
  Search,
  Upload,
  Waves,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftCard as Card } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import {
  formatSyncOffset,
  getAutoSyncBridge,
  type AutoSyncReferenceMode,
  type AutoSyncState,
} from "../../../bridges/auto-sync-bridge";
import { toast } from "../../../stores/notification-store";

interface AutoSyncSectionProps {
  clipId: string;
}

const ModeButton: React.FC<{
  active: boolean;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}> = ({ active, label, disabled, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`flex-1 rounded-[5px] px-2 py-[5px] text-[11px] font-medium transition-colors disabled:opacity-50 ${
      active
        ? "bg-bg-2 text-fg"
        : "text-fg-2 hover:bg-bg-2/50 hover:text-fg"
    }`}
  >
    {label}
  </button>
);

export const AutoSyncSection: React.FC<AutoSyncSectionProps> = ({ clipId }) => {
  const bridge = getAutoSyncBridge();
  const [state, setState] = useState<AutoSyncState>(bridge.getState());
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => bridge.subscribe(setState), [bridge]);

  const options =
    state.referenceMode === "timeline" ? bridge.getReferenceOptions(clipId) : [];
  // Stable primitive for the preselect effect (options itself is recomputed
  // every render so the list follows timeline edits).
  const onlyOptionId =
    options.length === 1 ? (options[0]?.clipId ?? null) : null;

  // Preselect the only reference clip when there is exactly one candidate.
  useEffect(() => {
    if (
      state.referenceMode === "timeline" &&
      !state.referenceClipId &&
      onlyOptionId
    ) {
      bridge.setReferenceClipId(onlyOptionId);
    }
  }, [bridge, state.referenceMode, state.referenceClipId, onlyOptionId]);

  const isThisClip = state.targetClipId === clipId;
  const result = isThisClip ? state.result : null;
  const canApply = Boolean(result?.valid) && !state.isProcessing;
  const referenceReady =
    state.referenceMode === "timeline"
      ? Boolean(state.referenceClipId)
      : Boolean(state.referenceFile);

  const handleModeChange = useCallback(
    (mode: AutoSyncReferenceMode) => {
      bridge.setReferenceMode(mode);
    },
    [bridge],
  );

  const handleReferenceClip = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      bridge.setReferenceClipId(event.target.value || null);
    },
    [bridge],
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      bridge.setReferenceFile(file);
      event.target.value = "";
    },
    [bridge],
  );

  const handleAnalyze = useCallback(async () => {
    const ok = await bridge.analyze(clipId);
    if (ok) {
      const analysis = bridge.getState().result;
      if (analysis?.valid) {
        toast.success(
          "Reference Matched",
          `Offset: ${formatSyncOffset(analysis.syncTime)} (score ${analysis.score.toFixed(2)})`,
        );
      }
    } else {
      const message = bridge.getState().error;
      if (message) toast.error("Auto Sync Failed", message);
    }
  }, [bridge, clipId]);

  const handleApply = useCallback(async () => {
    const ok = await bridge.apply(clipId);
    if (ok) {
      toast.success(
        "Clip Synced",
        "Alignment applied — use Ctrl+Z to undo.",
      );
    } else {
      const message = bridge.getState().error;
      if (message) toast.error("Auto Sync Failed", message);
    }
  }, [bridge, clipId]);

  return (
    <div className="space-y-3">
      <div className="flex gap-1 rounded-[7px] border border-border p-1">
        <ModeButton
          active={state.referenceMode === "timeline"}
          label="Timeline audio"
          disabled={state.isProcessing}
          onClick={() => handleModeChange("timeline")}
        />
        <ModeButton
          active={state.referenceMode === "file"}
          label="Audio file"
          disabled={state.isProcessing}
          onClick={() => handleModeChange("file")}
        />
      </div>

      {state.referenceMode === "timeline" ? (
        options.length > 0 ? (
          <select
            aria-label="Reference audio clip"
            value={state.referenceClipId ?? ""}
            onChange={handleReferenceClip}
            disabled={state.isProcessing}
            className="w-full appearance-none rounded-[7px] border border-border bg-transparent px-[10px] py-[8px] text-[13px] font-medium text-fg-2 outline-none focus:border-accent"
          >
            <option value="">Choose a reference clip…</option>
            {options.map((option) => (
              <option key={option.clipId} value={option.clipId}>
                {option.name} ({option.trackName})
              </option>
            ))}
          </select>
        ) : (
          <Text type="supporting" color="secondary" className="text-[10px]">
            Add an audio clip to the timeline to use it as the reference.
          </Text>
        )
      ) : (
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            label={state.referenceFile ? "Change file" : "Choose file"}
            size="sm"
            variant="secondary"
            icon={<Upload size={13} aria-hidden />}
            onClick={() => fileInputRef.current?.click()}
            isDisabled={state.isProcessing}
            className="flex-1 rounded text-[11px]"
          />
          {state.referenceFile && (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <Music size={12} className="flex-none text-fg-2" aria-hidden />
              <span
                className="truncate text-[11px] text-fg"
                title={state.referenceFile.name}
              >
                {state.referenceFile.name}
              </span>
            </div>
          )}
        </div>
      )}

      {state.isProcessing && state.progress && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Text type="supporting" color="secondary" className="text-[9px]">
              {state.progress.message}
            </Text>
            <Text type="supporting" color="secondary" className="text-[9px]">
              {state.progress.percent}%
            </Text>
          </div>
          <div className="h-1 bg-bg-1 rounded-full overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300"
              style={{ width: `${state.progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {result && (
        <Card variant="muted" padding={3}>
          <div className="flex items-center justify-between">
            <Text type="supporting" color="secondary">
              Offset
            </Text>
            <Text type="body" color="primary" weight="bold">
              {formatSyncOffset(result.syncTime)}
            </Text>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <Text type="supporting" color="secondary">
              Match score
            </Text>
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-semibold ${
                result.valid ? "text-success" : "text-error"
              }`}
            >
              {result.valid ? (
                <Check size={12} aria-hidden />
              ) : (
                <AlertCircle size={12} aria-hidden />
              )}
              {result.score.toFixed(2)}
            </span>
          </div>
          {!result.valid && (
            <Text type="supporting" color="secondary" className="mt-1 text-[9px]">
              Below the match threshold — this reference likely does not
              contain this clip&apos;s audio.
            </Text>
          )}
        </Card>
      )}

      {state.error && (
        <div className="flex items-start gap-1.5 text-error">
          <AlertCircle size={13} className="mt-px flex-none" aria-hidden />
          <Text type="supporting" color="secondary" className="text-[10px]">
            {state.error}
          </Text>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          label={
            state.isProcessing
              ? "Analyzing..."
              : result
                ? "Re-analyze"
                : "Analyze"
          }
          size="sm"
          variant={result ? "secondary" : "primary"}
          icon={
            state.isProcessing ? (
              <Loader2 size={14} className="animate-spin" aria-hidden />
            ) : (
              <Search size={14} aria-hidden />
            )
          }
          onClick={handleAnalyze}
          isDisabled={state.isProcessing || !referenceReady}
          className="flex-1 py-2 rounded text-[11px] font-medium transition-colors flex items-center justify-center gap-2"
        />
        {canApply && (
          <Button
            label="Apply"
            size="sm"
            variant="primary"
            icon={<Waves size={14} aria-hidden />}
            onClick={handleApply}
            className="flex-1 py-2 bg-primary hover:bg-primary-hover disabled:bg-primary/50 text-white rounded text-[11px] font-medium transition-colors flex items-center justify-center gap-2"
          />
        )}
      </div>

      {state.applied && !state.result && !state.error && (
        <div className="flex items-center gap-1.5 text-success">
          <Check size={13} aria-hidden />
          <Text type="supporting" color="secondary" className="text-[10px]">
            Clip aligned to the reference — Ctrl+Z to undo.
          </Text>
        </div>
      )}

      <Text
        type="supporting"
        color="secondary"
        className="text-center text-[9px]"
      >
        Positive offset delays the clip; negative trims its head. With a
        timeline reference the clip is placed at the reference&apos;s start.
      </Text>
    </div>
  );
};

export default AutoSyncSection;
