import React from "react";
import {
  Video,
  Type,
  Shapes,
  Zap,
  Shuffle,
  Sparkles,
  LayoutTemplate,
  SlidersHorizontal,
  Music,
  MessageSquare,
} from "@/icons/lucide-compat";
import type { AssetsTab } from "./AssetsPanel";

/**
 * Bottom tool dock — the phone/tablet equivalent of the desktop
 * media rail + action rail (reference: the scrollable tool dock in the
 * design brief).
 *
 * Every entry maps onto a real existing panel; nothing is a mock. The dock
 * launches panels as sheets/drawers while the preview and timeline stay on
 * screen, so editing context is never lost.
 */
export type DockTarget =
  | { kind: "assets"; tab: AssetsTab }
  | { kind: "inspector" }
  | { kind: "mixer" }
  | { kind: "chat" };

interface DockItem {
  id: string;
  label: string;
  icon: React.ElementType;
  target: DockTarget;
}

const DOCK_ITEMS: ReadonlyArray<DockItem> = [
  { id: "media", label: "Media", icon: Video, target: { kind: "assets", tab: "media" } },
  { id: "text", label: "Text", icon: Type, target: { kind: "assets", tab: "text" } },
  { id: "graphics", label: "Graphics", icon: Shapes, target: { kind: "assets", tab: "graphics" } },
  { id: "effects", label: "Effects", icon: Zap, target: { kind: "assets", tab: "effects" } },
  { id: "transitions", label: "Transitions", icon: Shuffle, target: { kind: "assets", tab: "transitions" } },
  { id: "ai", label: "AI", icon: Sparkles, target: { kind: "assets", tab: "ai" } },
  { id: "templates", label: "Templates", icon: LayoutTemplate, target: { kind: "assets", tab: "templates" } },
  { id: "edit", label: "Edit", icon: SlidersHorizontal, target: { kind: "inspector" } },
  { id: "mixer", label: "Mixer", icon: Music, target: { kind: "mixer" } },
  { id: "chat", label: "Chat", icon: MessageSquare, target: { kind: "chat" } },
];

export interface MobileToolDockProps {
  activePanel: "timeline" | "media" | "inspector" | "chat";
  activeAssetTab: AssetsTab;
  mixerVisible: boolean;
  hasSelection: boolean;
  onSelect: (target: DockTarget) => void;
}

export const MobileToolDock: React.FC<MobileToolDockProps> = ({
  activePanel,
  activeAssetTab,
  mixerVisible,
  hasSelection,
  onSelect,
}) => {
  const isPressed = (item: DockItem): boolean => {
    switch (item.target.kind) {
      case "assets":
        return activePanel === "media" && activeAssetTab === item.target.tab;
      case "inspector":
        return activePanel === "inspector";
      case "mixer":
        return mixerVisible;
      case "chat":
        return activePanel === "chat";
    }
  };

  return (
    <nav aria-label="Editor workspace" className="editor-tool-dock">
      {DOCK_ITEMS.map((item) => {
        const Icon = item.icon;
        const prominent = item.id === "edit" && hasSelection;
        return (
          <button
            key={item.id}
            type="button"
            className="dock-item"
            aria-pressed={isPressed(item)}
            data-prominent={prominent ? "true" : undefined}
            onClick={() => onSelect(item.target)}
          >
            <Icon size={19} strokeWidth={1.7} aria-hidden />
            <span>{item.label}</span>
            {prominent && <span className="dock-dot" aria-hidden="true" />}
          </button>
        );
      })}
    </nav>
  );
};

export default MobileToolDock;
