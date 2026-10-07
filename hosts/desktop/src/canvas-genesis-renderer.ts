import {
  RenderResult,
  type DisplayRenderPlan,
  type GenesisRenderer,
  type RendererState,
} from "@sevynos/graphics";
import {
  DESKTOP_VISUAL_METRICS,
  resolveDesktopAppearance,
  type DesktopAppearance,
  type DesktopApplicationSurface,
  type DesktopCursorSceneNode,
  type DesktopScene,
  type DesktopSceneNode,
  type DesktopStatusBarSceneNode,
  type DesktopWindowSceneNode,
  type WindowControlKind,
} from "@sevynos/desktop-shell/internal";
import type {
  NativeGradient,
  NativeIconCommand,
  NativeRenderCommand,
  NativeRuntimeSnapshot,
} from "@sevynos/react-native/internal";

function starPath(
  context: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
): void {
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 === 0 ? outerR : innerR;
    const px = cx + Math.cos(a) * rad;
    const py = cy + Math.sin(a) * rad;
    if (i === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
}

export class CanvasGenesisRenderer implements GenesisRenderer<DesktopScene> {
  readonly #canvas: HTMLCanvasElement;

  readonly #context: CanvasRenderingContext2D;

  #state: RendererState = "created";

  #nextFrameNumber = 1;
  #renderingSceneId: string | undefined;
  #appearance: DesktopAppearance = resolveDesktopAppearance("dark");
  #accent = "#d5aa4e";
  #cursorScale = 1;
  #scratchCanvas?: HTMLCanvasElement;
  #scratchContext?: CanvasRenderingContext2D | null;

  public constructor(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
    this.#canvas = canvas;
    this.#context = context;
  }

  public get state(): RendererState {
    return this.#state;
  }

  public initialize(): void {
    if (this.#state !== "created") {
      throw new Error(`Canvas renderer cannot initialize from state "${this.#state}".`);
    }

    this.#canvas.style.cursor = "none";
    this.#state = "initialized";
  }

  public render(plan: DisplayRenderPlan<DesktopScene>): RenderResult {
    if (this.#state !== "initialized") {
      throw new Error(`Canvas renderer cannot render from state "${this.#state}".`);
    }

    const startedAt = new Date();
    this.#appearance = resolveDesktopAppearance(plan.scene.settings.theme);
    this.#accent = plan.scene.settings.accentColor;
    this.#cursorScale = plan.scene.settings.cursorSize;
    const { width, height, scaleFactor } = plan.scene.viewport;

    const physicalWidth = Math.floor(width * scaleFactor);
    const physicalHeight = Math.floor(height * scaleFactor);
    if (this.#canvas.width !== physicalWidth) this.#canvas.width = physicalWidth;
    if (this.#canvas.height !== physicalHeight) this.#canvas.height = physicalHeight;
    this.#canvas.style.width = `${String(width)}px`;
    this.#canvas.style.height = `${String(height)}px`;
    this.#context.setTransform(scaleFactor, 0, 0, scaleFactor, 0, 0);
    if (this.#renderingSceneId !== plan.scene.base.id) {
      this.#context.clearRect(0, 0, width, height);
      this.#renderingSceneId = plan.scene.base.id;
    }

    this.#context.save();
    this.#context.beginPath();
    this.#context.rect(
      plan.displayBounds.x,
      plan.displayBounds.y,
      plan.displayBounds.width,
      plan.displayBounds.height,
    );
    this.#context.clip();

    for (const node of plan.scene.nodes) {
      this.#renderNode(node);
    }
    this.#context.restore();

    const result = new RenderResult({
      frameNumber: this.#nextFrameNumber,
      displayId: plan.displayId,
      status: "rendered",
      startedAt,
      completedAt: new Date(),
      commandCount: plan.scene.nodes.length,
    });

    this.#nextFrameNumber += 1;
    return result;
  }

  public shutdown(): void {
    if (this.#state !== "initialized") {
      throw new Error(`Canvas renderer cannot shut down from state "${this.#state}".`);
    }

    this.#state = "shutdown";
  }

  #renderNode(node: DesktopSceneNode): void {
    switch (node.kind) {
      case "desktop-background":
        this.#drawBackground(node.bounds);
        return;
      case "desktop-status-bar":
        this.#drawStatusBar(node);
        return;
      case "desktop-window":
        this.#drawWindow(node);
        return;
      case "desktop-taskbar":
        this.#drawTaskbar(
          node.bounds.x,
          node.bounds.y,
          node.bounds.width,
          node.bounds.height,
          node.activeWorkspace,
        );
        return;
      case "desktop-launcher-button":
        this.#drawLauncherButton(node.bounds, node.open);
        return;
      case "desktop-launcher-surface":
        this.#drawLauncherSurface(node.bounds);
        return;
      case "desktop-launcher-header":
        this.#drawLauncherHeader(node.bounds, node.title);
        return;
      case "desktop-launcher-search":
        this.#drawLauncherSearch(node.bounds, node.query, node.placeholder);
        return;
      case "desktop-launcher-entry":
        this.#drawLauncherEntry(node.bounds, node.label, node.iconLabel, node.running);
        return;
      case "desktop-taskbar-application":
        this.#drawButton(
          node.bounds,
          `${node.minimized ? "◇ " : ""}${node.label}`,
          node.focused,
          true,
        );
        return;
      case "desktop-reset-action":
        this.#drawButton(node.bounds, node.label, false);
        return;
      case "desktop-workspace-control":
        this.#drawButton(node.bounds, node.workspaceId.slice(-1), node.active);
        return;
      case "desktop-workspace-action":
        this.#drawButton(node.bounds, node.label, false);
        return;
      case "desktop-workspace-item":
        this.#drawWorkspaceItem(node);
        return;
      case "desktop-settings-control":
        return;
      case "desktop-diagnostics-control":
        this.#drawButton(node.bounds, node.label, false);
        return;
      case "desktop-recovery":
        this.#context.fillStyle = this.#appearance.recovery.surface;
        this.#context.fillRect(
          node.bounds.x,
          node.bounds.y,
          node.bounds.width,
          node.bounds.height,
        );
        this.#context.fillStyle = this.#appearance.recovery.primary;
        this.#context.font = "700 28px system-ui";
        this.#context.textAlign = "center";
        this.#context.fillText(
          "Genesis Recovery",
          node.bounds.width / 2,
          node.bounds.height / 2 - 30,
        );
        this.#context.font = "14px system-ui";
        this.#context.fillText(
          node.message,
          node.bounds.width / 2,
          node.bounds.height / 2 + 10,
        );
        return;
      case "desktop-recovery-control":
        this.#drawButton(node.bounds, node.label, false);
        return;
      case "desktop-cursor":
        this.#drawCursor(node);
    }
  }

  #drawBackground(bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): void {
    const context = this.#context;
    const appearance = this.#appearance.background;
    const isDark = this.#appearance.mode === "dark";

    // Base background gradient
    const gradient = context.createLinearGradient(
      bounds.x,
      bounds.y,
      bounds.x + bounds.width,
      bounds.y + bounds.height,
    );
    gradient.addColorStop(0, appearance.start);
    gradient.addColorStop(0.48, appearance.middle);
    gradient.addColorStop(1, appearance.end);
    context.fillStyle = gradient;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

    // Primary ambient cosmic violet glow
    const glow = context.createRadialGradient(
      bounds.x + bounds.width * DESKTOP_VISUAL_METRICS.backgroundGlowX,
      bounds.y + bounds.height * DESKTOP_VISUAL_METRICS.backgroundGlowY,
      0,
      bounds.x + bounds.width * DESKTOP_VISUAL_METRICS.backgroundGlowX,
      bounds.y + bounds.height * DESKTOP_VISUAL_METRICS.backgroundGlowY,
      bounds.width * DESKTOP_VISUAL_METRICS.backgroundGlowRadius,
    );
    glow.addColorStop(0, appearance.glowStart);
    glow.addColorStop(0.48, appearance.glowMiddle);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = glow;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

    // Secondary celestial gold nebula glow
    const goldGlow = context.createRadialGradient(
      bounds.x + bounds.width * 0.2,
      bounds.y + bounds.height * 0.82,
      0,
      bounds.x + bounds.width * 0.2,
      bounds.y + bounds.height * 0.82,
      bounds.width * 0.45,
    );
    goldGlow.addColorStop(
      0,
      isDark ? "rgba(230, 196, 122, 0.12)" : "rgba(230, 196, 122, 0.08)",
    );
    goldGlow.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = goldGlow;
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

    // Coordinate matrix grid lines
    context.strokeStyle = isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.03)";
    context.lineWidth = 1;
    for (const ratio of [0.33, 0.67]) {
      const lineY = Math.round(bounds.y + bounds.height * ratio);
      const lineX = Math.round(bounds.x + bounds.width * ratio);
      context.beginPath();
      context.moveTo(bounds.x, lineY);
      context.lineTo(bounds.x + bounds.width, lineY);
      context.stroke();
      context.beginPath();
      context.moveTo(lineX, bounds.y);
      context.lineTo(lineX, bounds.y + bounds.height);
      context.stroke();
    }

    // Precision grid dots
    context.fillStyle = appearance.grid;
    const spacing = DESKTOP_VISUAL_METRICS.backgroundGridSpacing;
    for (let y = bounds.y + spacing / 2; y < bounds.y + bounds.height; y += spacing) {
      for (let x = bounds.x + spacing / 2; x < bounds.x + bounds.width; x += spacing) {
        context.fillRect(Math.floor(x), Math.floor(y), 1.5, 1.5);
      }
    }

    // Central Sevyn Luxury Emblem Lattice
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    context.save();
    context.strokeStyle = isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(0, 0, 0, 0.06)";
    context.lineWidth = 1;
    // Crosshairs
    context.beginPath();
    context.moveTo(cx - 180, cy);
    context.lineTo(cx + 180, cy);
    context.moveTo(cx, cy - 180);
    context.lineTo(cx, cy + 180);
    context.stroke();

    // Rotated 45-degree diamond lattice
    context.translate(cx, cy);
    context.rotate(Math.PI / 4);

    // Outer diamond
    context.strokeStyle = isDark
      ? "rgba(230, 196, 122, 0.22)"
      : "rgba(180, 145, 75, 0.24)";
    context.lineWidth = 1.5;
    context.strokeRect(-80, -80, 160, 160);

    // Inner diamond
    context.strokeStyle = isDark
      ? "rgba(159, 168, 255, 0.28)"
      : "rgba(100, 110, 200, 0.24)";
    context.lineWidth = 1;
    context.strokeRect(-55, -55, 110, 110);

    // Core diamond with subtle gold fill
    context.fillStyle = isDark
      ? "rgba(230, 196, 122, 0.12)"
      : "rgba(230, 196, 122, 0.15)";
    context.strokeStyle = isDark
      ? "rgba(230, 196, 122, 0.45)"
      : "rgba(180, 145, 75, 0.45)";
    context.lineWidth = 1;
    context.fillRect(-22, -22, 44, 44);
    context.strokeRect(-22, -22, 44, 44);

    context.restore();
  }

  #drawWindow(node: DesktopWindowSceneNode): void {
    const { bounds, focused } = node.base;
    const context = this.#context;
    const appearance = this.#appearance.window;
    const shadow = focused ? appearance.focusedShadow : appearance.unfocusedShadow;
    const titleBarHeight = DESKTOP_VISUAL_METRICS.titleBarHeight;

    context.save();
    context.shadowColor = shadow.color;
    context.shadowBlur = shadow.blur;
    context.shadowOffsetY = shadow.offsetY;
    context.fillStyle = appearance.surface;
    context.beginPath();
    context.roundRect(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      DESKTOP_VISUAL_METRICS.windowRadius,
    );
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = focused ? appearance.focusedBorder : appearance.unfocusedBorder;
    context.lineWidth = 1;
    context.stroke();
    context.fillStyle = focused
      ? appearance.focusedTitleBar
      : appearance.unfocusedTitleBar;
    context.beginPath();
    context.roundRect(bounds.x, bounds.y, bounds.width, titleBarHeight, [
      DESKTOP_VISUAL_METRICS.windowRadius,
      DESKTOP_VISUAL_METRICS.windowRadius,
      0,
      0,
    ]);
    context.fill();

    const badgeSize = 22;
    const badgeX = bounds.x + 16;
    const badgeY = bounds.y + Math.round((titleBarHeight - badgeSize) / 2);
    context.fillStyle = this.#appearance.button.surface;
    context.strokeStyle = this.#appearance.button.border;
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(badgeX, badgeY, badgeSize, badgeSize, 6);
    context.fill();
    context.stroke();
    context.fillStyle = focused
      ? this.#appearance.button.activeIndicator
      : appearance.unfocusedTitle;
    const monogram = resolveWindowBadge(node.title);
    context.font =
      monogram.length > 2
        ? '700 8.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
        : monogram.length > 1
          ? '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
          : '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(monogram, badgeX + badgeSize / 2, badgeY + badgeSize / 2);

    context.fillStyle = focused ? appearance.focusedTitle : appearance.unfocusedTitle;
    context.font = '580 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "start";
    context.textBaseline = "middle";
    context.fillText(
      node.title,
      badgeX + badgeSize + 8,
      bounds.y + titleBarHeight / 2 + 0.5,
    );
    context.fillStyle = appearance.divider;
    context.fillRect(bounds.x + 1, bounds.y + titleBarHeight - 1, bounds.width - 2, 1);

    context.save();
    context.beginPath();
    context.rect(
      node.contentBounds.x,
      node.contentBounds.y,
      node.contentBounds.width,
      node.contentBounds.height,
    );
    context.clip();
    if (node.nativeSurface !== undefined) {
      context.translate(node.contentBounds.x, node.contentBounds.y);
      this.#drawNativeSurface(node.nativeSurface);
    } else if (node.surface !== undefined) {
      this.#drawApplicationSurface(
        node.surface,
        bounds.x,
        bounds.y,
        node.systemMonitorSnapshot,
        node.settingsSnapshot,
      );
    }
    context.restore();

    for (const control of node.controls) {
      const available = control.kind !== "restore" || node.maximized;
      context.fillStyle = available
        ? appearance.availableControl
        : appearance.unavailableControl;
      context.beginPath();
      context.roundRect(control.x, control.y, control.width, control.height, 7);
      context.fill();
      this.#drawWindowControlIcon(
        control.kind,
        control.x,
        control.y,
        control.width,
        control.height,
        available
          ? control.kind === "close"
            ? appearance.closeControl
            : appearance.control
          : appearance.unavailableControlIcon,
      );
    }

    context.restore();
  }

  #drawApplicationSurface(
    surface: DesktopApplicationSurface,
    windowX: number,
    windowY: number,
    systemMonitorSnapshot: DesktopWindowSceneNode["systemMonitorSnapshot"],
    settingsSnapshot: DesktopWindowSceneNode["settingsSnapshot"],
  ): void {
    const context = this.#context;
    context.textAlign = "start";

    switch (surface.kind) {
      case "welcome": {
        context.fillStyle = this.#appearance.content.primary;
        context.font = "700 24px system-ui";
        context.fillText(surface.heading, windowX + 24, windowY + 88);
        context.fillStyle = this.#appearance.content.secondary;
        context.font = "14px system-ui";
        surface.body.forEach((line, index) => {
          context.fillText(line, windowX + 24, windowY + 124 + index * 24);
        });
        const statusItems = surface.runtimeStatus
          .split("·")
          .map((s) => s.trim())
          .filter(Boolean);
        let chipX = windowX + 24;
        const chipY = windowY + 186;
        for (const item of statusItems) {
          context.font = "600 12px ui-monospace, monospace";
          const textWidth = context.measureText(item).width;
          const chipWidth = textWidth + 28;
          context.fillStyle =
            this.#appearance.mode === "dark"
              ? "rgba(46, 160, 67, 0.15)"
              : "rgba(31, 136, 61, 0.1)";
          context.strokeStyle =
            this.#appearance.mode === "dark"
              ? "rgba(46, 160, 67, 0.35)"
              : "rgba(31, 136, 61, 0.3)";
          context.beginPath();
          context.roundRect(chipX, chipY, chipWidth, 24, 6);
          context.fill();
          context.stroke();
          context.fillStyle = this.#appearance.content.success;
          context.fillText(`● ${item}`, chipX + 8, chipY + 16);
          chipX += chipWidth + 10;
        }
        return;
      }
      case "console": {
        const terminalX = windowX + 20;
        const terminalY = windowY + 70;
        const terminalWidth = 460;
        const terminalHeight = 220;
        context.fillStyle = "#0D1117";
        context.strokeStyle = "rgba(255, 255, 255, 0.1)";
        context.beginPath();
        context.roundRect(terminalX, terminalY, terminalWidth, terminalHeight, 8);
        context.fill();
        context.stroke();
        context.fillStyle = "#161B22";
        context.beginPath();
        context.roundRect(terminalX, terminalY, terminalWidth, 24, [8, 8, 0, 0]);
        context.fill();
        const dotColors = ["#FF5F56", "#FFBD2E", "#27C93F"] as const;
        for (let i = 0; i < 3; i += 1) {
          const dotColor = dotColors[i];
          if (dotColor === undefined) continue;
          context.fillStyle = dotColor;
          context.beginPath();
          context.arc(terminalX + 14 + i * 14, terminalY + 12, 4, 0, Math.PI * 2);
          context.fill();
        }
        context.fillStyle = "#7D8590";
        context.font = "11px ui-monospace, monospace";
        context.fillText(
          "bash - 80x24",
          terminalX + terminalWidth / 2 - 35,
          terminalY + 16,
        );

        context.fillStyle = this.#appearance.content.console;
        context.font = "13px ui-monospace, monospace";
        surface.history.slice(-6).forEach((line, index) => {
          context.fillText(line, terminalX + 16, terminalY + 46 + index * 20);
        });
        context.fillStyle = "#58A6FF";
        context.fillText(
          surface.prompt,
          terminalX + 16,
          terminalY + 46 + Math.min(surface.history.length, 6) * 20,
        );
        const promptWidth = context.measureText(surface.prompt).width;
        context.fillStyle = "#F0F6FC";
        context.fillText(
          `${surface.input}▌`,
          terminalX + 16 + promptWidth,
          terminalY + 46 + Math.min(surface.history.length, 6) * 20,
        );
        return;
      }
      case "system-monitor": {
        context.fillStyle = this.#appearance.content.primary;
        context.font = "700 22px system-ui";
        context.fillText(surface.heading, windowX + 24, windowY + 86);
        const snapshot = systemMonitorSnapshot;
        if (snapshot === undefined) return;
        context.fillStyle = this.#appearance.content.console;
        context.font = "14px ui-monospace, monospace";
        const lines = [
          `Running sessions: ${String(snapshot.runningApplicationSessions)}`,
          `Open windows: ${String(snapshot.openWindows)}`,
          `Focused window: ${snapshot.focusedWindow ?? "None"}`,
          `Cursor: ${snapshot.cursorKind}`,
          `Frames executed: ${String(snapshot.frameExecutionCount)}`,
          `Active workspace: ${snapshot.activeWorkspace}`,
        ];
        lines.forEach((line, index) => {
          context.fillText(line, windowX + 24, windowY + 126 + index * 28);
        });
        return;
      }
      case "settings": {
        if (settingsSnapshot === undefined) return;
        return;
      }
      case "gallery":
        return;
    }
  }

  #drawNativeSurface(surface: NativeRuntimeSnapshot): void {
    for (const command of surface.commands) this.#drawNativeCommand(command);
  }

  #drawNativeCommand(command: NativeRenderCommand): void {
    const context = this.#context;
    const { bounds } = command;
    switch (command.kind) {
      case "clip-start":
        context.save();
        context.beginPath();
        context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
        context.clip();
        return;
      case "clip-end":
        context.restore();
        return;
      case "material": {
        context.save();
        if (command.opacity !== undefined) {
          context.globalAlpha *= command.opacity;
        }

        // 1. Backdrop blur for frosted glass panels
        if (command.backdropBlur && command.backdropBlur > 0) {
          context.save();
          context.beginPath();
          if (command.radii !== undefined) {
            context.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, [
              command.radii.topLeft ?? command.radius,
              command.radii.topRight ?? command.radius,
              command.radii.bottomRight ?? command.radius,
              command.radii.bottomLeft ?? command.radius,
            ]);
          } else {
            context.roundRect(
              bounds.x,
              bounds.y,
              bounds.width,
              bounds.height,
              command.radius,
            );
          }
          context.clip();

          if (this.#scratchCanvas === undefined && typeof document !== "undefined") {
            this.#scratchCanvas = document.createElement("canvas");
            this.#scratchContext = this.#scratchCanvas.getContext("2d");
          }
          if (this.#scratchCanvas !== undefined && this.#scratchContext) {
            const pw = Math.max(1, Math.ceil(bounds.width));
            const ph = Math.max(1, Math.ceil(bounds.height));
            if (this.#scratchCanvas.width < pw || this.#scratchCanvas.height < ph) {
              this.#scratchCanvas.width = Math.max(this.#scratchCanvas.width, pw);
              this.#scratchCanvas.height = Math.max(this.#scratchCanvas.height, ph);
            }
            this.#scratchContext.clearRect(0, 0, pw, ph);
            try {
              this.#scratchContext.drawImage(
                this.#canvas,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
                0,
                0,
                bounds.width,
                bounds.height,
              );
              context.filter = `blur(${String(command.backdropBlur)}px)`;
              context.drawImage(
                this.#scratchCanvas,
                0,
                0,
                bounds.width,
                bounds.height,
                bounds.x,
                bounds.y,
                bounds.width,
                bounds.height,
              );
              context.filter = "none";
            } catch {
              // Ignore if drawImage throws in mock environment
            }
          }
          context.restore();
        }

        // 2. Drop / box shadow
        if (command.shadow !== undefined) {
          let shadowColor = command.shadow.color;
          if (command.shadow.opacity !== undefined && command.shadow.opacity < 1) {
            const parsed = parseCanvasColor(shadowColor);
            if (parsed) {
              shadowColor = `rgba(${String(parsed[0])}, ${String(parsed[1])}, ${String(parsed[2])}, ${String((parsed[3] / 255) * command.shadow.opacity)})`;
            }
          }
          context.shadowColor = shadowColor;
          context.shadowBlur = command.shadow.blur;
          context.shadowOffsetY = command.shadow.y;
          if (command.shadow.x !== undefined) {
            context.shadowOffsetX = command.shadow.x;
          }
        }

        // 3. Fill: Gradient or color wash
        if (command.gradient !== undefined) {
          context.fillStyle = createCanvasGradient(context, bounds, command.gradient);
        } else {
          context.fillStyle = command.color;
        }

        // 4. Layer blur
        if (command.blur && command.blur > 0) {
          context.filter = `blur(${String(command.blur)}px)`;
        }

        context.beginPath();
        if (command.radii !== undefined) {
          context.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, [
            command.radii.topLeft ?? command.radius,
            command.radii.topRight ?? command.radius,
            command.radii.bottomRight ?? command.radius,
            command.radii.bottomLeft ?? command.radius,
          ]);
        } else {
          context.roundRect(
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            command.radius,
          );
        }
        context.fill();
        context.shadowColor = "transparent";
        context.filter = "none";

        // 5. Borders
        if (command.borderColor !== undefined) {
          context.strokeStyle = command.borderColor;
          context.lineWidth = command.borderWidth ?? 1;
          if (command.borderStyle === "dashed") {
            context.setLineDash([4, 4]);
          } else if (command.borderStyle === "dotted") {
            context.setLineDash([2, 2]);
          } else {
            context.setLineDash([]);
          }
          context.stroke();
        }
        context.restore();
        return;
      }
      case "text": {
        context.save();
        if (command.opacity !== undefined) {
          context.globalAlpha *= command.opacity;
        }
        context.fillStyle = command.color;
        const fontStyle = command.fontStyle ? `${command.fontStyle} ` : "";
        const fontFamily = command.fontFamily ?? "system-ui";
        context.font = `${fontStyle}${String(command.weight)} ${String(command.size)}px ${fontFamily}`;
        context.textAlign = command.align ?? "start";
        const lineHeight = command.lineHeight ?? command.size * 1.4;
        const lines =
          command.lines && command.lines.length > 0
            ? command.lines
            : command.text.includes("\n")
              ? command.text.split("\n")
              : undefined;

        if (lines !== undefined && lines.length > 1) {
          context.textBaseline = "top";
          const textX =
            command.align === "center"
              ? bounds.x + bounds.width / 2
              : command.align === "end"
                ? bounds.x + bounds.width
                : bounds.x;
          lines.forEach((line, index) => {
            const lineY = bounds.y + index * lineHeight;
            if (lineY + lineHeight <= bounds.y + bounds.height + 4)
              context.fillText(line, textX, lineY, bounds.width);
          });
        } else {
          const singleText = lines ? (lines[0] ?? command.text) : command.text;
          context.textBaseline = "middle";
          context.fillText(
            singleText,
            command.align === "center"
              ? bounds.x + bounds.width / 2
              : command.align === "end"
                ? bounds.x + bounds.width
                : bounds.x,
            bounds.y + bounds.height / 2,
            bounds.width,
          );
        }
        context.restore();
        return;
      }
      case "separator":
        context.save();
        if (command.opacity !== undefined) {
          context.globalAlpha *= command.opacity;
        }
        context.fillStyle = command.color;
        context.fillRect(bounds.x, bounds.y, bounds.width, Math.max(0.5, bounds.height));
        context.restore();
        return;
      case "control": {
        context.save();
        if (command.opacity !== undefined) {
          context.globalAlpha *= command.opacity;
        }
        if (command.shadow !== undefined) {
          let shadowColor = command.shadow.color;
          if (command.shadow.opacity !== undefined && command.shadow.opacity < 1) {
            const parsed = parseCanvasColor(shadowColor);
            if (parsed) {
              shadowColor = `rgba(${String(parsed[0])}, ${String(parsed[1])}, ${String(parsed[2])}, ${String((parsed[3] / 255) * command.shadow.opacity)})`;
            }
          }
          context.shadowColor = shadowColor;
          context.shadowBlur = command.shadow.blur;
          context.shadowOffsetY = command.shadow.y;
          if (command.shadow.x !== undefined) {
            context.shadowOffsetX = command.shadow.x;
          }
        }
        const disabled = command.state === "disabled";
        const active = command.state === "focused" || command.state === "pressed";
        const hovered = command.state === "hovered";
        if (disabled) context.globalAlpha *= 0.42;
        context.fillStyle = active ? command.accent : command.background;
        context.beginPath();
        context.roundRect(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          command.radius,
        );
        context.fill();
        context.shadowColor = "transparent";
        if (hovered && !active && !disabled) {
          context.fillStyle = "rgba(255, 255, 255, 0.08)";
          context.fill();
        }
        if (command.borderWidth && command.borderColor) {
          context.strokeStyle = command.borderColor;
          context.lineWidth = command.borderWidth;
          context.stroke();
        } else if (command.state === "focused") {
          context.strokeStyle = command.accent;
          context.lineWidth = 2;
          context.stroke();
        }
        if (command.value) {
          context.fillStyle = active ? "#19140A" : command.foreground;
          context.font = "600 12px system-ui";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.fillText(
            command.value,
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
            bounds.width - 12,
          );
        }
        context.restore();
        return;
      }
      case "icon": {
        if (command.opacity !== undefined) {
          context.save();
          context.globalAlpha *= command.opacity;
          this.#drawNativeIcon(command);
          context.restore();
        } else {
          this.#drawNativeIcon(command);
        }
        return;
      }
      case "gradient": {
        context.save();
        if (command.opacity !== undefined) {
          context.globalAlpha *= command.opacity;
        }
        context.fillStyle = createCanvasGradient(context, bounds, command.gradient);
        context.beginPath();
        if (command.radii !== undefined) {
          context.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, [
            command.radii.topLeft ?? command.radius,
            command.radii.topRight ?? command.radius,
            command.radii.bottomRight ?? command.radius,
            command.radii.bottomLeft ?? command.radius,
          ]);
        } else {
          context.roundRect(
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            command.radius,
          );
        }
        context.fill();
        if (command.borderColor !== undefined) {
          context.strokeStyle = command.borderColor;
          context.lineWidth = command.borderWidth ?? 1;
          context.stroke();
        }
        context.restore();
        return;
      }
      case "bitmap":
        return;
    }
  }

  #drawNativeIcon(command: NativeIconCommand): void {
    const { x, y, width, height } = command.bounds;
    const context = this.#context;
    context.save();
    context.strokeStyle = command.color;
    context.fillStyle = command.color;
    context.lineWidth = Math.max(1.6, Math.min(width, height) * 0.075);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    const cx = x + width / 2;
    const cy = y + height / 2;
    const r = Math.min(width, height) * 0.36;
    switch (command.icon) {
      case "appearance":
        context.arc(cx, cy, Math.min(width, height) * 0.34, -Math.PI / 2, Math.PI / 2);
        context.lineTo(cx, cy - height * 0.34);
        break;
      case "color":
        context.moveTo(cx, y + 2);
        context.lineTo(x + width - 2, cy);
        context.lineTo(cx, y + height - 2);
        context.lineTo(x + 2, cy);
        context.closePath();
        break;
      case "display":
        context.roundRect(x + 1, y + 2, width - 2, height - 6, 3);
        context.moveTo(cx - 4, y + height - 1);
        context.lineTo(cx + 4, y + height - 1);
        break;
      case "workspace":
        context.rect(x + 2, y + 2, width * 0.38, height * 0.38);
        context.rect(cx, cy, width * 0.38, height * 0.38);
        break;
      case "pointer":
        context.moveTo(x + 3, y + 2);
        context.lineTo(cx + 2, y + height - 3);
        context.lineTo(cx + 4, cy + 3);
        context.lineTo(x + width - 2, cy + 1);
        context.closePath();
        break;
      case "motion":
        context.moveTo(x + 1, cy - 4);
        context.bezierCurveTo(cx - 3, y, cx + 3, y + height, x + width - 1, cy + 4);
        break;
      case "history":
        context.arc(cx, cy, Math.min(width, height) * 0.36, -2.4, 2.4);
        context.moveTo(cx, cy);
        context.lineTo(cx, cy - 5);
        context.lineTo(cx + 4, cy);
        break;
      case "controls":
        context.moveTo(x + 2, y + 5);
        context.lineTo(x + width - 2, y + 5);
        context.moveTo(x + 2, cy);
        context.lineTo(x + width - 2, cy);
        context.moveTo(x + 2, y + height - 5);
        context.lineTo(x + width - 2, y + height - 5);
        break;
      case "gallery":
      case "search":
        context.arc(cx, cy, Math.min(width, height) * 0.3, 0, Math.PI * 2);
        break;
      // --- SevynOS application icons: monochrome line-art renditions of the
      // per-app SVG sets (applications/<app>/icons/<app>.svg). Drawn in the
      // icon color on the app's brand tile by ApplicationIcon.
      case "app-browser":
        context.arc(cx, cy, r, 0, Math.PI * 2);
        context.moveTo(cx + r * 0.45, cy - r);
        context.ellipse(cx, cy, r * 0.45, r, 0, 0, Math.PI * 2);
        context.moveTo(cx - r * 0.94, cy - r * 0.42);
        context.lineTo(cx + r * 0.94, cy - r * 0.42);
        context.moveTo(cx - r * 0.94, cy + r * 0.42);
        context.lineTo(cx + r * 0.94, cy + r * 0.42);
        break;
      case "app-calculator":
        context.roundRect(
          x + width * 0.3,
          y + height * 0.12,
          width * 0.4,
          height * 0.76,
          2.5,
        );
        context.moveTo(x + width * 0.3, y + height * 0.34);
        context.lineTo(x + width * 0.7, y + height * 0.34);
        for (const row of [0.48, 0.62, 0.76]) {
          for (const col of [0.4, 0.5, 0.6]) {
            context.moveTo(x + width * col, y + height * row);
            context.lineTo(x + width * col + 0.6, y + height * row);
          }
        }
        break;
      case "app-camera":
        context.moveTo(cx - width * 0.12, y + height * 0.32);
        context.lineTo(cx - width * 0.08, y + height * 0.22);
        context.lineTo(cx + width * 0.08, y + height * 0.22);
        context.lineTo(cx + width * 0.12, y + height * 0.32);
        context.roundRect(
          x + width * 0.12,
          y + height * 0.32,
          width * 0.76,
          height * 0.46,
          3,
        );
        context.moveTo(cx + r * 0.62, cy + r * 0.16);
        context.arc(cx, cy + r * 0.16, r * 0.42, 0, Math.PI * 2);
        break;
      case "app-files":
        context.moveTo(x + width * 0.16, y + height * 0.4);
        context.lineTo(x + width * 0.16, y + height * 0.28);
        context.lineTo(x + width * 0.36, y + height * 0.28);
        context.lineTo(x + width * 0.44, y + height * 0.4);
        context.moveTo(x + width * 0.16, y + height * 0.4);
        context.lineTo(x + width * 0.84, y + height * 0.4);
        context.lineTo(x + width * 0.84, y + height * 0.74);
        context.lineTo(x + width * 0.16, y + height * 0.74);
        context.closePath();
        break;
      case "app-music":
        context.moveTo(cx - width * 0.08, cy + height * 0.22);
        context.lineTo(cx - width * 0.08, y + height * 0.2);
        context.lineTo(cx + width * 0.2, y + height * 0.14);
        context.lineTo(cx + width * 0.2, cy + height * 0.16);
        context.moveTo(cx - width * 0.08 + r * 0.34, cy + height * 0.22);
        context.arc(cx - width * 0.08, cy + height * 0.22, r * 0.34, 0, Math.PI * 2);
        context.moveTo(cx + width * 0.2 + r * 0.34, cy + height * 0.16);
        context.arc(cx + width * 0.2, cy + height * 0.16, r * 0.34, 0, Math.PI * 2);
        break;
      case "app-notes":
        context.moveTo(x + width * 0.28, y + height * 0.14);
        context.lineTo(x + width * 0.56, y + height * 0.14);
        context.lineTo(x + width * 0.72, y + height * 0.3);
        context.lineTo(x + width * 0.72, y + height * 0.86);
        context.lineTo(x + width * 0.28, y + height * 0.86);
        context.closePath();
        context.moveTo(x + width * 0.56, y + height * 0.14);
        context.lineTo(x + width * 0.56, y + height * 0.3);
        context.lineTo(x + width * 0.72, y + height * 0.3);
        context.moveTo(x + width * 0.38, cy + height * 0.02);
        context.lineTo(x + width * 0.62, cy + height * 0.02);
        context.moveTo(x + width * 0.38, cy + height * 0.16);
        context.lineTo(x + width * 0.56, cy + height * 0.16);
        break;
      case "app-settings":
      case "gear":
        context.arc(cx, cy, r * 0.42, 0, Math.PI * 2);
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          context.moveTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62);
          context.lineTo(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92);
        }
        break;
      case "app-sevyn-code":
        context.moveTo(cx - width * 0.1, cy - height * 0.14);
        context.lineTo(cx - width * 0.26, cy);
        context.lineTo(cx - width * 0.1, cy + height * 0.14);
        context.moveTo(cx + width * 0.1, cy - height * 0.14);
        context.lineTo(cx + width * 0.26, cy);
        context.lineTo(cx + width * 0.1, cy + height * 0.14);
        context.moveTo(cx + width * 0.06, y + height * 0.2);
        context.lineTo(cx - width * 0.06, y + height * 0.8);
        break;
      case "app-store":
        // Shopping-bag glyph: line-art rendition of applications/store/icons/store.svg.
        context.moveTo(x + width * 0.19, y + height * 0.4);
        context.lineTo(x + width * 0.25, y + height * 0.23);
        context.lineTo(x + width * 0.75, y + height * 0.23);
        context.lineTo(x + width * 0.81, y + height * 0.4);
        context.moveTo(x + width * 0.19, y + height * 0.4);
        context.lineTo(x + width * 0.81, y + height * 0.4);
        context.lineTo(x + width * 0.76, y + height * 0.81);
        context.lineTo(x + width * 0.24, y + height * 0.81);
        context.closePath();
        context.moveTo(x + width * 0.38, y + height * 0.52);
        context.lineTo(x + width * 0.44, y + height * 0.65);
        context.lineTo(x + width * 0.6, y + height * 0.48);
        break;
      case "app-system-monitor":
        context.roundRect(
          x + width * 0.14,
          y + height * 0.14,
          width * 0.72,
          height * 0.72,
          3,
        );
        context.moveTo(x + width * 0.26, cy + height * 0.08);
        context.lineTo(x + width * 0.37, cy + height * 0.08);
        context.lineTo(x + width * 0.44, cy - height * 0.12);
        context.lineTo(x + width * 0.54, cy + height * 0.18);
        context.lineTo(x + width * 0.6, cy + height * 0.02);
        context.lineTo(x + width * 0.72, cy + height * 0.02);
        break;
      case "app-terminal":
        context.roundRect(
          x + width * 0.14,
          y + height * 0.14,
          width * 0.72,
          height * 0.72,
          3,
        );
        context.moveTo(cx - width * 0.16, cy - height * 0.08);
        context.lineTo(cx - width * 0.05, cy + height * 0.01);
        context.lineTo(cx - width * 0.16, cy + height * 0.1);
        context.moveTo(cx + width * 0.02, cy + height * 0.16);
        context.lineTo(cx + width * 0.16, cy + height * 0.16);
        break;
      case "app-text-editor":
        context.moveTo(x + width * 0.28, y + height * 0.12);
        context.lineTo(x + width * 0.52, y + height * 0.12);
        context.lineTo(x + width * 0.7, y + height * 0.3);
        context.lineTo(x + width * 0.7, y + height * 0.86);
        context.lineTo(x + width * 0.28, y + height * 0.86);
        context.closePath();
        context.moveTo(x + width * 0.52, y + height * 0.12);
        context.lineTo(x + width * 0.52, y + height * 0.3);
        context.lineTo(x + width * 0.7, y + height * 0.3);
        context.moveTo(x + width * 0.38, cy + height * 0.04);
        context.lineTo(x + width * 0.6, cy + height * 0.04);
        context.moveTo(x + width * 0.38, cy + height * 0.18);
        context.lineTo(x + width * 0.54, cy + height * 0.18);
        break;
      case "app-welcome":
        context.arc(cx, cy + height * 0.08, r * 0.52, Math.PI, Math.PI * 2);
        context.moveTo(x + width * 0.16, cy + height * 0.08);
        context.lineTo(x + width * 0.84, cy + height * 0.08);
        context.moveTo(cx, y + height * 0.12);
        context.lineTo(cx, y + height * 0.24);
        context.moveTo(cx - r * 0.62, y + height * 0.26);
        context.lineTo(cx - r * 0.42, y + height * 0.36);
        context.moveTo(cx + r * 0.62, y + height * 0.26);
        context.lineTo(cx + r * 0.42, y + height * 0.36);
        context.moveTo(cx - width * 0.14, cy + height * 0.26);
        context.lineTo(cx + width * 0.14, cy + height * 0.26);
        break;
      // --- Generic UI glyphs (emoji-free iconography for apps and shell).
      case "home":
        context.moveTo(cx, y + height * 0.18);
        context.lineTo(x + width * 0.82, cy - height * 0.04);
        context.lineTo(x + width * 0.82, y + height * 0.8);
        context.lineTo(x + width * 0.62, y + height * 0.8);
        context.lineTo(x + width * 0.62, cy + height * 0.12);
        context.lineTo(x + width * 0.38, cy + height * 0.12);
        context.lineTo(x + width * 0.38, y + height * 0.8);
        context.lineTo(x + width * 0.18, y + height * 0.8);
        context.lineTo(x + width * 0.18, cy - height * 0.04);
        context.closePath();
        break;
      case "monitor":
        context.roundRect(
          x + width * 0.14,
          y + height * 0.18,
          width * 0.72,
          height * 0.5,
          2.5,
        );
        context.moveTo(cx - width * 0.12, y + height * 0.82);
        context.lineTo(cx + width * 0.12, y + height * 0.82);
        context.moveTo(cx, y + height * 0.68);
        context.lineTo(cx, y + height * 0.82);
        break;
      case "file-text":
        context.moveTo(x + width * 0.3, y + height * 0.14);
        context.lineTo(x + width * 0.7, y + height * 0.14);
        context.lineTo(x + width * 0.7, y + height * 0.86);
        context.lineTo(x + width * 0.3, y + height * 0.86);
        context.closePath();
        for (const row of [0.34, 0.48, 0.62]) {
          context.moveTo(x + width * 0.4, y + height * row);
          context.lineTo(x + width * 0.6, y + height * row);
        }
        break;
      case "download":
        context.moveTo(cx, y + height * 0.18);
        context.lineTo(cx, cy + height * 0.08);
        context.moveTo(cx - width * 0.12, cy - height * 0.02);
        context.lineTo(cx, cy + height * 0.08);
        context.lineTo(cx + width * 0.12, cy - height * 0.02);
        context.moveTo(x + width * 0.22, y + height * 0.62);
        context.lineTo(x + width * 0.22, y + height * 0.8);
        context.lineTo(x + width * 0.78, y + height * 0.8);
        context.lineTo(x + width * 0.78, y + height * 0.62);
        break;
      case "image":
        context.roundRect(
          x + width * 0.16,
          y + height * 0.22,
          width * 0.68,
          height * 0.56,
          2.5,
        );
        context.moveTo(cx - width * 0.14 + r * 0.2, cy - height * 0.1);
        context.arc(cx - width * 0.14, cy - height * 0.1, r * 0.2, 0, Math.PI * 2);
        context.moveTo(x + width * 0.16, y + height * 0.66);
        context.lineTo(x + width * 0.4, y + height * 0.46);
        context.lineTo(x + width * 0.54, y + height * 0.58);
        context.lineTo(x + width * 0.64, y + height * 0.48);
        context.lineTo(x + width * 0.84, y + height * 0.66);
        break;
      case "music-note":
        context.moveTo(cx + width * 0.1, y + height * 0.18);
        context.lineTo(cx + width * 0.1, cy + height * 0.18);
        context.moveTo(cx + width * 0.1 + r * 0.36, cy + height * 0.18);
        context.arc(cx + width * 0.1, cy + height * 0.18, r * 0.36, 0, Math.PI * 2);
        break;
      case "film":
        context.roundRect(
          x + width * 0.16,
          y + height * 0.2,
          width * 0.68,
          height * 0.6,
          2.5,
        );
        for (const row of [0.32, 0.68]) {
          for (const col of [0.28, 0.5, 0.72]) {
            context.moveTo(x + width * col, y + height * row);
            context.lineTo(x + width * col + 1.2, y + height * row);
          }
        }
        break;
      case "trash":
        context.moveTo(x + width * 0.3, y + height * 0.24);
        context.lineTo(x + width * 0.7, y + height * 0.24);
        context.moveTo(cx, y + height * 0.24);
        context.lineTo(cx, y + height * 0.16);
        context.moveTo(x + width * 0.36, y + height * 0.24);
        context.lineTo(x + width * 0.32, y + height * 0.8);
        context.lineTo(x + width * 0.68, y + height * 0.8);
        context.lineTo(x + width * 0.64, y + height * 0.24);
        context.moveTo(cx - width * 0.07, y + height * 0.4);
        context.lineTo(cx - width * 0.09, y + height * 0.68);
        context.moveTo(cx + width * 0.07, y + height * 0.4);
        context.lineTo(cx + width * 0.09, y + height * 0.68);
        break;
      case "folder":
        context.moveTo(x + width * 0.16, y + height * 0.38);
        context.lineTo(x + width * 0.16, y + height * 0.28);
        context.lineTo(x + width * 0.4, y + height * 0.28);
        context.lineTo(x + width * 0.46, y + height * 0.38);
        context.lineTo(x + width * 0.84, y + height * 0.38);
        context.lineTo(x + width * 0.84, y + height * 0.72);
        context.lineTo(x + width * 0.16, y + height * 0.72);
        context.closePath();
        break;
      case "globe":
        context.arc(cx, cy, r, 0, Math.PI * 2);
        context.moveTo(cx + r * 0.5, cy - r);
        context.ellipse(cx, cy, r * 0.5, r, 0, 0, Math.PI * 2);
        context.moveTo(cx - r * 0.87, cy);
        context.lineTo(cx + r * 0.87, cy);
        break;
      case "book":
        context.moveTo(cx, y + height * 0.2);
        context.lineTo(x + width * 0.28, y + height * 0.16);
        context.lineTo(x + width * 0.28, y + height * 0.8);
        context.lineTo(cx, y + height * 0.84);
        context.lineTo(x + width * 0.72, y + height * 0.8);
        context.lineTo(x + width * 0.72, y + height * 0.16);
        context.lineTo(cx, y + height * 0.2);
        context.moveTo(cx, y + height * 0.2);
        context.lineTo(cx, y + height * 0.84);
        break;
      case "star":
        starPath(context, cx, cy, r * 0.95, r * 0.42);
        break;
      case "wifi":
        context.moveTo(cx - r * 0.28, cy + r * 0.42);
        context.arc(cx, cy + r * 0.42, r * 0.28, Math.PI * 1.25, Math.PI * 1.75);
        context.moveTo(cx - r * 0.62, cy + r * 0.42);
        context.arc(cx, cy + r * 0.42, r * 0.62, Math.PI * 1.25, Math.PI * 1.75);
        context.moveTo(cx - r * 0.95, cy + r * 0.42);
        context.arc(cx, cy + r * 0.42, r * 0.95, Math.PI * 1.25, Math.PI * 1.75);
        context.beginPath();
        context.arc(cx, cy + r * 0.42, r * 0.12, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        break;
      case "volume":
        context.moveTo(x + width * 0.24, cy - height * 0.08);
        context.lineTo(x + width * 0.4, cy - height * 0.08);
        context.lineTo(x + width * 0.54, y + height * 0.24);
        context.lineTo(x + width * 0.54, y + height * 0.76);
        context.lineTo(x + width * 0.4, cy + height * 0.08);
        context.lineTo(x + width * 0.24, cy + height * 0.08);
        context.closePath();
        context.moveTo(x + width * 0.62, cy - height * 0.14);
        context.arc(cx + width * 0.08, cy, r * 0.5, -Math.PI / 3, Math.PI / 3);
        context.moveTo(x + width * 0.62, cy - height * 0.26);
        context.arc(cx + width * 0.08, cy, r * 0.85, -Math.PI / 3, Math.PI / 3);
        break;
      case "battery":
        context.roundRect(
          x + width * 0.14,
          cy - height * 0.18,
          width * 0.66,
          height * 0.36,
          2.5,
        );
        context.moveTo(x + width * 0.84, cy - height * 0.08);
        context.lineTo(x + width * 0.88, cy - height * 0.08);
        context.lineTo(x + width * 0.88, cy + height * 0.08);
        context.lineTo(x + width * 0.84, cy + height * 0.08);
        break;
      case "clock":
        context.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
        context.moveTo(cx, cy);
        context.lineTo(cx, cy - r * 0.5);
        context.moveTo(cx, cy);
        context.lineTo(cx + r * 0.36, cy + r * 0.14);
        break;
      case "package":
        context.moveTo(cx, y + height * 0.18);
        context.lineTo(x + width * 0.8, cy - height * 0.02);
        context.lineTo(x + width * 0.8, y + height * 0.72);
        context.lineTo(cx, y + height * 0.84);
        context.lineTo(x + width * 0.2, y + height * 0.72);
        context.lineTo(x + width * 0.2, cy - height * 0.02);
        context.closePath();
        context.moveTo(x + width * 0.2, cy - height * 0.02);
        context.lineTo(cx, cy + height * 0.08);
        context.lineTo(x + width * 0.8, cy - height * 0.02);
        context.moveTo(cx, cy + height * 0.08);
        context.lineTo(cx, y + height * 0.84);
        break;
      case "keyboard":
        context.roundRect(
          x + width * 0.14,
          cy - height * 0.2,
          width * 0.72,
          height * 0.4,
          2.5,
        );
        for (const row of [-0.08, 0.06]) {
          for (const col of [-0.2, -0.07, 0.07, 0.2]) {
            context.moveTo(cx + width * col, cy + height * row);
            context.lineTo(cx + width * col + 1.2, cy + height * row);
          }
        }
        context.moveTo(cx - width * 0.16, cy + height * 0.14);
        context.lineTo(cx + width * 0.16, cy + height * 0.14);
        break;
      case "info":
        context.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
        context.moveTo(cx, cy - r * 0.1);
        context.lineTo(cx, cy + r * 0.5);
        context.beginPath();
        context.arc(cx, cy - r * 0.38, r * 0.1, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        break;
      case "check":
        context.moveTo(x + width * 0.24, cy + height * 0.02);
        context.lineTo(cx - width * 0.02, cy + height * 0.22);
        context.lineTo(x + width * 0.78, y + height * 0.26);
        break;
      case "warning":
        context.moveTo(cx, y + height * 0.18);
        context.lineTo(x + width * 0.84, y + height * 0.78);
        context.lineTo(x + width * 0.16, y + height * 0.78);
        context.closePath();
        context.moveTo(cx, cy - height * 0.04);
        context.lineTo(cx, cy + height * 0.18);
        context.beginPath();
        context.arc(cx, cy + height * 0.34, r * 0.09, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        break;
      case "lock":
        context.moveTo(x + width * 0.32, cy + height * 0.02);
        context.lineTo(x + width * 0.32, cy - height * 0.1);
        context.arc(cx, cy - height * 0.1, width * 0.18, Math.PI, Math.PI * 2);
        context.lineTo(x + width * 0.68, cy + height * 0.02);
        context.roundRect(
          x + width * 0.28,
          cy - height * 0.02,
          width * 0.44,
          height * 0.4,
          2.5,
        );
        break;
      case "heart":
        context.moveTo(cx, y + height * 0.78);
        context.bezierCurveTo(
          x + width * 0.1,
          cy + height * 0.1,
          cx - width * 0.28,
          y + height * 0.28,
          cx - width * 0.28,
          cy - height * 0.06,
        );
        context.bezierCurveTo(
          cx - width * 0.28,
          cy - height * 0.24,
          cx - width * 0.06,
          cy - height * 0.24,
          cx,
          cy - height * 0.06,
        );
        context.bezierCurveTo(
          cx + width * 0.06,
          cy - height * 0.24,
          cx + width * 0.28,
          cy - height * 0.24,
          cx + width * 0.28,
          cy - height * 0.06,
        );
        context.bezierCurveTo(
          cx + width * 0.28,
          y + height * 0.28,
          x + width * 0.9,
          cy + height * 0.1,
          cx,
          y + height * 0.78,
        );
        break;
      case "airplane":
        context.moveTo(x + width * 0.16, cy + height * 0.1);
        context.lineTo(x + width * 0.84, y + height * 0.18);
        context.lineTo(cx + width * 0.02, cy + height * 0.22);
        context.lineTo(x + width * 0.42, cy + height * 0.04);
        context.closePath();
        break;
      case "brightness":
        context.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          context.moveTo(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
          context.lineTo(cx + Math.cos(a) * r * 0.92, cy + Math.sin(a) * r * 0.92);
        }
        break;
      case "zap":
        context.moveTo(cx + width * 0.08, y + height * 0.14);
        context.lineTo(cx - width * 0.16, cy + height * 0.1);
        context.lineTo(cx - width * 0.02, cy + height * 0.1);
        context.lineTo(cx - width * 0.08, y + height * 0.86);
        context.lineTo(cx + width * 0.16, cy - height * 0.1);
        context.lineTo(cx + width * 0.02, cy - height * 0.1);
        context.closePath();
        break;
      case "hard-drive":
        context.roundRect(
          x + width * 0.14,
          cy - height * 0.22,
          width * 0.72,
          height * 0.44,
          2.5,
        );
        context.beginPath();
        context.arc(x + width * 0.26, cy, r * 0.08, 0, Math.PI * 2);
        context.fill();
        context.beginPath();
        context.moveTo(x + width * 0.4, cy);
        context.lineTo(x + width * 0.76, cy);
        break;
      case "menu":
        for (const row of [0.32, 0.5, 0.68]) {
          context.moveTo(x + width * 0.24, y + height * row);
          context.lineTo(x + width * 0.76, y + height * row);
        }
        break;
      case "grid":
        for (const row of [0.26, 0.54]) {
          for (const col of [0.26, 0.54]) {
            context.rect(x + width * col, y + height * row, width * 0.2, height * 0.2);
          }
        }
        break;
      case "edit":
        context.moveTo(x + width * 0.3, y + height * 0.7);
        context.lineTo(x + width * 0.58, y + height * 0.28);
        context.lineTo(x + width * 0.68, y + height * 0.18);
        context.lineTo(x + width * 0.74, y + height * 0.24);
        context.lineTo(x + width * 0.64, y + height * 0.34);
        context.lineTo(x + width * 0.36, y + height * 0.76);
        context.lineTo(x + width * 0.24, y + height * 0.78);
        context.closePath();
        break;
      case "x":
        context.moveTo(x + width * 0.28, y + height * 0.28);
        context.lineTo(x + width * 0.72, y + height * 0.72);
        context.moveTo(x + width * 0.72, y + height * 0.28);
        context.lineTo(x + width * 0.28, y + height * 0.72);
        break;
      case "refresh":
        context.arc(cx, cy, r * 0.85, -Math.PI * 0.35, Math.PI * 1.15);
        context.moveTo(cx + r * 0.95, cy - r * 0.42);
        context.lineTo(cx + r * 0.42, cy - r * 0.62);
        context.lineTo(cx + r * 0.72, cy - r * 0.05);
        break;
      case "moon": {
        const mr = r * 0.72;
        context.arc(cx, cy, mr, 0.9, Math.PI * 2 - 0.9);
        context.arc(cx + mr * 0.5, cy, mr * 0.79, 1.42, Math.PI * 2 - 1.42);
        break;
      }
      case "bluetooth":
        context.moveTo(cx, y + height * 0.16);
        context.lineTo(cx, y + height * 0.84);
        context.moveTo(cx - width * 0.24, cy - height * 0.24);
        context.lineTo(cx + width * 0.24, cy);
        context.lineTo(cx - width * 0.24, cy + height * 0.24);
        context.moveTo(cx, y + height * 0.16);
        context.lineTo(cx + width * 0.24, cy);
        context.lineTo(cx, y + height * 0.84);
        break;
    }
    context.stroke();
    context.restore();
  }

  #drawStatusBar(node: DesktopStatusBarSceneNode): void {
    const context = this.#context;
    const { bounds, activeWorkspace } = node;
    const isDark = this.#appearance.mode === "dark";
    context.save();

    // Translucent glass surface
    context.fillStyle = isDark ? "rgba(10, 13, 20, 0.82)" : "rgba(240, 243, 248, 0.88)";
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

    // Top specular highlight line
    context.strokeStyle = isDark
      ? "rgba(255, 255, 255, 0.14)"
      : "rgba(255, 255, 255, 0.65)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(bounds.x, bounds.y + 0.5);
    context.lineTo(bounds.x + bounds.width, bounds.y + 0.5);
    context.stroke();

    // Bottom subtle border
    context.strokeStyle = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.08)";
    context.beginPath();
    context.moveTo(bounds.x, bounds.y + bounds.height - 0.5);
    context.lineTo(bounds.x + bounds.width, bounds.y + bounds.height - 0.5);
    context.stroke();

    const centerY = bounds.y + bounds.height / 2;

    // --- Left: Brand Mark (Diamond) + SEVYN OS + Workspace Pill ---
    let leftX = bounds.x + 16;
    context.save();
    context.translate(leftX + 5, centerY);
    context.rotate(Math.PI / 4);
    context.fillStyle = "#E6C47A";
    context.fillRect(-3, -3, 6, 6);
    context.restore();

    leftX += 16;
    context.fillStyle = isDark ? "#FFFFFF" : "#1A1C23";
    context.font = '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "start";
    context.textBaseline = "middle";
    context.fillText("SEVYN OS", leftX, centerY);
    const sevynWidth = context.measureText("SEVYN OS").width;
    leftX += sevynWidth + 12;

    // Workspace Pill
    const wsLabel = activeWorkspace.replace("workspace-", "WORKSPACE ");
    context.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const wsWidth = context.measureText(wsLabel).width;
    const pillWidth = wsWidth + 16;
    const pillHeight = 18;
    const pillY = centerY - pillHeight / 2;

    context.fillStyle = isDark
      ? "rgba(230, 196, 122, 0.12)"
      : "rgba(230, 196, 122, 0.18)";
    context.beginPath();
    context.roundRect(leftX, pillY, pillWidth, pillHeight, 5);
    context.fill();
    context.strokeStyle = isDark ? "rgba(230, 196, 122, 0.3)" : "rgba(180, 145, 75, 0.4)";
    context.stroke();

    context.fillStyle = isDark ? "#E6C47A" : "#8A6D3B";
    context.textAlign = "center";
    context.fillText(wsLabel, leftX + pillWidth / 2, centerY);

    // --- Center: Live Clock & Date ---
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dateStr = now
      .toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
      .toUpperCase();
    const clockText = `${timeStr}  ·  ${dateStr}`;

    context.fillStyle = isDark ? "#E2E5F0" : "#2B2D36";
    context.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.fillText(clockText, bounds.x + bounds.width / 2, centerY);

    // --- Right: Status Indicator (Emerald online dot + Connected) + 100% ---
    let rightX = bounds.x + bounds.width - 16;

    // Battery / Power Pill "100%"
    context.font = '600 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const pText = "100%";
    const pWidth = context.measureText(pText).width + 12;
    rightX -= pWidth;
    context.fillStyle = isDark ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0.05)";
    context.beginPath();
    context.roundRect(rightX, centerY - 9, pWidth, 18, 5);
    context.fill();
    context.fillStyle = isDark ? "#9CA3AF" : "#6B7280";
    context.textAlign = "center";
    context.fillText(pText, rightX + pWidth / 2, centerY);

    // Online Status Indicator
    rightX -= 10;
    const statusLabel = "Connected";
    context.font = '500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const statusWidth = context.measureText(statusLabel).width;
    const statusPillWidth = statusWidth + 24;
    rightX -= statusPillWidth;

    context.fillStyle = isDark ? "rgba(255, 255, 255, 0.04)" : "rgba(0, 0, 0, 0.03)";
    context.strokeStyle = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.08)";
    context.beginPath();
    context.roundRect(rightX, centerY - 10, statusPillWidth, 20, 10);
    context.fill();
    context.stroke();

    // Green online dot
    context.fillStyle = "#4CC38A";
    context.beginPath();
    context.arc(rightX + 8, centerY, 3, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = isDark ? "#CBD5E1" : "#475569";
    context.textAlign = "start";
    context.fillText(statusLabel, rightX + 16, centerY);

    context.restore();
  }

  #drawTaskbar(
    x: number,
    y: number,
    width: number,
    height: number,
    workspace: string,
  ): void {
    const context = this.#context;
    const appearance = this.#appearance.taskbar;
    context.save();
    context.shadowColor = appearance.shadow.color;
    context.shadowBlur = appearance.shadow.blur;
    context.shadowOffsetY = appearance.shadow.offsetY;
    context.fillStyle = appearance.surface;
    context.beginPath();
    context.roundRect(
      x + 6,
      y + 4,
      width - 12,
      height - 8,
      DESKTOP_VISUAL_METRICS.taskbarRadius,
    );
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = appearance.border;
    context.lineWidth = 1;
    context.stroke();

    // Top glass highlight line
    context.strokeStyle =
      this.#appearance.mode === "dark"
        ? "rgba(255, 255, 255, 0.12)"
        : "rgba(255, 255, 255, 0.45)";
    context.beginPath();
    context.moveTo(x + 6 + DESKTOP_VISUAL_METRICS.taskbarRadius, y + 5);
    context.lineTo(x + width - 6 - DESKTOP_VISUAL_METRICS.taskbarRadius, y + 5);
    context.stroke();

    context.fillStyle = appearance.text;
    context.font = '520 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      workspace.replace("workspace-", "Workspace "),
      x + width / 2,
      y + height / 2,
    );
    context.restore();
  }

  #drawButton(
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    label: string,
    active: boolean,
    isTaskbarApp = false,
  ): void {
    const context = this.#context;
    const appearance = this.#appearance.button;
    context.save();
    context.fillStyle = active ? this.#accent : appearance.surface;
    context.beginPath();
    context.roundRect(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      DESKTOP_VISUAL_METRICS.buttonRadius,
    );
    context.fill();
    context.strokeStyle = active ? appearance.activeBorder : appearance.border;
    context.lineWidth = 1;
    context.stroke();

    if (isTaskbarApp && bounds.width >= 60) {
      const chipSize = 20;
      const chipX = bounds.x + 8;
      const chipY = bounds.y + Math.round((bounds.height - chipSize) / 2);
      context.fillStyle = active
        ? "rgba(255, 255, 255, 0.22)"
        : this.#appearance.mode === "dark"
          ? "rgba(255, 255, 255, 0.12)"
          : "rgba(0, 0, 0, 0.08)";
      context.beginPath();
      context.roundRect(chipX, chipY, chipSize, chipSize, 5);
      context.fill();
      const cleanLabel = label.replace(/^[◇\s]+/, "");
      const chipLetter = resolveWindowBadge(cleanLabel);
      context.fillStyle = active ? appearance.activeText : appearance.text;
      context.font =
        chipLetter.length > 1
          ? '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
          : '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(chipLetter, chipX + chipSize / 2, chipY + chipSize / 2);

      context.font = '570 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      context.textAlign = "start";
      context.textBaseline = "middle";
      context.save();
      context.beginPath();
      context.rect(
        chipX + chipSize + 6,
        bounds.y,
        Math.max(0, bounds.width - (chipSize + 16)),
        bounds.height,
      );
      context.clip();
      context.fillText(cleanLabel, chipX + chipSize + 6, bounds.y + bounds.height / 2);
      context.restore();
    } else {
      context.fillStyle = active ? appearance.activeText : appearance.text;
      context.font = '570 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    }

    if (active) {
      context.fillStyle = appearance.activeIndicator;
      context.beginPath();
      context.roundRect(
        bounds.x + bounds.width / 2 - 8,
        bounds.y + bounds.height - 4,
        16,
        2,
        1,
      );
      context.fill();
    }
    context.restore();
  }

  #drawWorkspaceItem(
    node: Extract<DesktopSceneNode, { readonly kind: "desktop-workspace-item" }>,
  ): void {
    const context = this.#context;
    const centerX = node.bounds.x + node.bounds.width / 2;
    const iconY = node.bounds.y + 10;
    const iconWidth = 42;
    const iconHeight = 34;
    const iconX = centerX - iconWidth / 2;
    context.save();
    context.fillStyle = node.itemKind === "directory" ? "#E6C47A" : this.#accent;
    context.strokeStyle = "rgba(255, 255, 255, 0.35)";
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(iconX, iconY, iconWidth, iconHeight, 8);
    context.fill();
    context.stroke();
    context.fillStyle = "#17120A";
    context.font = '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(
      node.itemKind === "directory" ? "DIR" : "TXT",
      centerX,
      iconY + iconHeight / 2,
    );
    context.fillStyle = this.#appearance.content.primary;
    context.font = '500 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.fillText(node.label, centerX, node.bounds.y + 58, node.bounds.width - 8);
    context.restore();
  }

  #drawLauncherButton(
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    active: boolean,
  ): void {
    this.#drawButton(bounds, "", active);
    const context = this.#context;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    context.save();
    context.fillStyle = active
      ? "#E6C47A"
      : this.#appearance.mode === "light"
        ? "#8A6D3B"
        : "#E6C47A";
    context.strokeStyle = active ? "#FFE5A3" : "rgba(230, 196, 122, 0.7)";
    context.lineWidth = 1;
    for (const [offsetX, offsetY] of [
      [0, -7],
      [-7, 0],
      [7, 0],
      [0, 7],
    ] as const) {
      context.save();
      context.translate(centerX + offsetX, centerY + offsetY);
      context.rotate(Math.PI / 4);
      context.fillRect(-3, -3, 6, 6);
      context.strokeRect(-3, -3, 6, 6);
      context.restore();
    }
    context.restore();
  }

  #drawLauncherSurface(bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }): void {
    const context = this.#context;
    context.save();
    if (this.#scratchCanvas === undefined && typeof document !== "undefined") {
      this.#scratchCanvas = document.createElement("canvas");
      this.#scratchContext = this.#scratchCanvas.getContext("2d");
    }
    if (this.#scratchCanvas !== undefined && this.#scratchContext) {
      const pw = Math.max(1, Math.ceil(bounds.width));
      const ph = Math.max(1, Math.ceil(bounds.height));
      if (this.#scratchCanvas.width < pw || this.#scratchCanvas.height < ph) {
        this.#scratchCanvas.width = Math.max(this.#scratchCanvas.width, pw);
        this.#scratchCanvas.height = Math.max(this.#scratchCanvas.height, ph);
      }
      this.#scratchContext.clearRect(0, 0, pw, ph);
      try {
        this.#scratchContext.drawImage(
          this.#canvas,
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          0,
          0,
          bounds.width,
          bounds.height,
        );
        context.filter = "blur(24px)";
        context.drawImage(
          this.#scratchCanvas,
          0,
          0,
          bounds.width,
          bounds.height,
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
        );
        context.filter = "none";
      } catch {
        // Fallback for environments where canvas readback/drawImage fails
      }
    }
    context.fillStyle =
      this.#appearance.mode === "light"
        ? "rgba(240, 243, 248, 0.75)"
        : "rgba(7, 9, 13, 0.78)";
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.restore();
  }

  #drawLauncherHeader(
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    title: string,
  ): void {
    const context = this.#context;
    context.save();
    context.fillStyle = this.#appearance.content.primary;
    context.font = '700 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textAlign = "start";
    context.textBaseline = "middle";
    context.fillText(title, bounds.x, bounds.y + bounds.height / 2);
    context.restore();
  }

  #drawLauncherSearch(
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    query: string,
    placeholder: string,
  ): void {
    const context = this.#context;
    context.save();
    context.fillStyle =
      this.#appearance.mode === "light"
        ? "rgba(255, 255, 255, 0.85)"
        : "rgba(24, 29, 38, 0.84)";
    context.strokeStyle = this.#appearance.launcher.border;
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(bounds.x, bounds.y, bounds.width, bounds.height, 12);
    context.fill();
    context.stroke();

    const textX = bounds.x + 16;
    const centerY = bounds.y + bounds.height / 2;
    context.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textBaseline = "middle";
    context.textAlign = "start";
    if (query.length > 0) {
      context.fillStyle = this.#appearance.content.primary;
      context.fillText(query, textX, centerY);
    } else {
      context.fillStyle = this.#appearance.content.secondary;
      context.fillText(placeholder, textX, centerY);
    }
    context.restore();
  }

  #drawLauncherEntry(
    bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    label: string,
    iconLabel: string | undefined,
    running: boolean,
  ): void {
    const context = this.#context;
    const appearance = this.#appearance.launcher;
    context.save();
    context.shadowColor = appearance.shadow.color;
    context.shadowBlur = appearance.shadow.blur;
    context.shadowOffsetY = appearance.shadow.offsetY;
    context.fillStyle = appearance.surface;
    context.beginPath();
    context.roundRect(
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      DESKTOP_VISUAL_METRICS.launcherRadius,
    );
    context.fill();
    context.shadowColor = "transparent";
    context.strokeStyle = appearance.border;
    context.stroke();

    if (bounds.height > 80) {
      // Grid tile layout
      const iconSize = 48;
      const iconX = bounds.x + (bounds.width - iconSize) / 2;
      const iconY = bounds.y + 16;
      const iconGradient = context.createLinearGradient(
        iconX,
        iconY,
        iconX + iconSize,
        iconY + iconSize,
      );
      iconGradient.addColorStop(0, this.#accent);
      iconGradient.addColorStop(1, appearance.iconEnd);
      context.fillStyle = iconGradient;
      context.beginPath();
      context.roundRect(iconX, iconY, iconSize, iconSize, 12);
      context.fill();

      if (iconLabel) {
        context.fillStyle = "#FFFFFF";
        context.font =
          '700 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(iconLabel, iconX + iconSize / 2, iconY + iconSize / 2);
      }

      context.fillStyle = appearance.text;
      context.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(label, bounds.x + bounds.width / 2, bounds.y + bounds.height - 24);

      if (running) {
        context.fillStyle = this.#accent;
        context.beginPath();
        context.arc(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height - 8,
          3,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    } else {
      // Legacy horizontal row layout
      const iconGradient = context.createLinearGradient(
        bounds.x + 10,
        bounds.y + 9,
        bounds.x + 38,
        bounds.y + 37,
      );
      iconGradient.addColorStop(0, this.#accent);
      iconGradient.addColorStop(1, appearance.iconEnd);
      context.fillStyle = iconGradient;
      context.beginPath();
      context.roundRect(bounds.x + 10, bounds.y + 8, 28, 28, 8);
      context.fill();
      if (iconLabel) {
        context.fillStyle = "#FFFFFF";
        context.font =
          '700 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(iconLabel, bounds.x + 24, bounds.y + 22);
      }
      context.fillStyle = appearance.text;
      context.font = '560 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      context.textAlign = "start";
      context.textBaseline = "middle";
      context.fillText(label, bounds.x + 50, bounds.y + bounds.height / 2);
      if (running) {
        context.fillStyle = this.#accent;
        context.beginPath();
        context.arc(
          bounds.x + bounds.width - 18,
          bounds.y + bounds.height / 2,
          3.5,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    }
    context.restore();
  }

  #drawCursor(node: DesktopCursorSceneNode): void {
    if (!node.visible || node.cursorKind === "hidden") {
      return;
    }

    const { x, y } = node.position;
    const context = this.#context;
    context.save();
    context.translate(x, y);
    context.scale(this.#cursorScale, this.#cursorScale);
    context.translate(-x, -y);
    context.fillStyle = this.#appearance.cursor.fill;
    context.strokeStyle = this.#appearance.cursor.outline;
    context.lineWidth = 1.5;
    context.lineJoin = "round";

    if (node.cursorKind === "pointer") {
      context.beginPath();
      context.moveTo(x + 4, y);
      context.lineTo(x + 8, y);
      context.lineTo(x + 8, y + 8);
      context.lineTo(x + 11, y + 8);
      context.lineTo(x + 14, y + 10);
      context.lineTo(x + 15, y + 14);
      context.lineTo(x + 14, y + 20);
      context.lineTo(x + 4, y + 20);
      context.lineTo(x, y + 14);
      context.lineTo(x, y + 10);
      context.lineTo(x + 4, y + 8);
      context.closePath();
      context.fill();
      context.stroke();
      context.restore();
      return;
    }

    if (node.cursorKind === "text") {
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x - 4, y - 8);
      context.lineTo(x + 4, y - 8);
      context.moveTo(x, y - 8);
      context.lineTo(x, y + 8);
      context.moveTo(x - 4, y + 8);
      context.lineTo(x + 4, y + 8);
      context.stroke();
      context.restore();
      return;
    }

    if (node.cursorKind === "resize-ew") {
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x - 8, y);
      context.lineTo(x + 8, y);
      context.moveTo(x - 4, y - 4);
      context.lineTo(x - 8, y);
      context.lineTo(x - 4, y + 4);
      context.moveTo(x + 4, y - 4);
      context.lineTo(x + 8, y);
      context.lineTo(x + 4, y + 4);
      context.stroke();
      context.restore();
      return;
    }

    if (node.cursorKind === "resize-ns") {
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo(x, y - 8);
      context.lineTo(x, y + 8);
      context.moveTo(x - 4, y - 4);
      context.lineTo(x, y - 8);
      context.lineTo(x + 4, y - 4);
      context.moveTo(x - 4, y + 4);
      context.lineTo(x, y + 8);
      context.lineTo(x + 4, y + 4);
      context.stroke();
      context.restore();
      return;
    }

    context.beginPath();
    context.moveTo(x, y - 0.5);
    context.lineTo(x, y + 17);
    context.lineTo(x + 4.5, y + 12.5);
    context.lineTo(x + 7.5, y + 17);
    context.lineTo(x + 9.5, y + 15.5);
    context.lineTo(x + 6.8, y + 11.2);
    context.lineTo(x + 15.5, y + 12.8);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
  }

  #drawWindowControlIcon(
    control: WindowControlKind,
    x: number,
    y: number,
    width: number,
    height: number,
    color: string,
  ): void {
    const context = this.#context;
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    const extent = Math.min(width, height) * 0.22;
    context.save();
    context.strokeStyle = color;
    context.lineWidth = 1.6;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    switch (control) {
      case "minimize":
        context.moveTo(centerX - extent, centerY);
        context.lineTo(centerX + extent, centerY);
        break;
      case "maximize":
        context.roundRect(
          centerX - extent,
          centerY - extent,
          extent * 2,
          extent * 2,
          1.5,
        );
        break;
      case "restore":
        context.roundRect(
          centerX - extent,
          centerY - extent * 0.55,
          extent * 1.55,
          extent * 1.55,
          1.5,
        );
        context.moveTo(centerX - extent * 0.4, centerY - extent * 0.55);
        context.lineTo(centerX - extent * 0.4, centerY - extent);
        context.lineTo(centerX + extent, centerY - extent);
        context.lineTo(centerX + extent, centerY + extent * 0.4);
        break;
      case "close":
        context.moveTo(centerX - extent, centerY - extent);
        context.lineTo(centerX + extent, centerY + extent);
        context.moveTo(centerX + extent, centerY - extent);
        context.lineTo(centerX - extent, centerY + extent);
    }
    context.stroke();
    context.restore();
  }
}

function resolveWindowBadge(title: string): string {
  const lower = title.toLocaleLowerCase();
  if (lower.includes("studio") || lower.includes("ide")) return "</>";
  if (lower.includes("console") || lower.includes("terminal")) return ">_";
  if (lower.includes("browser") || lower.includes("web")) return "🌐";
  if (lower.includes("file")) return "📁";
  if (lower.includes("setting")) return "⚙";
  if (lower.includes("monitor")) return "📊";
  if (lower.includes("note")) return "📝";
  if (lower.includes("gallery")) return "UI";
  return title.charAt(0) || "•";
}

function createCanvasGradient(
  context: CanvasRenderingContext2D,
  bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  gradient: NativeGradient,
): CanvasGradient {
  let grad: CanvasGradient;
  if (gradient.kind === "linear") {
    const angle = gradient.angle ?? 180;
    const rad = (angle * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const len = Math.max(1, Math.abs(bounds.width * dx) + Math.abs(bounds.height * dy));
    const halfLen = len / 2;
    grad = context.createLinearGradient(
      cx - dx * halfLen,
      cy - dy * halfLen,
      cx + dx * halfLen,
      cy + dy * halfLen,
    );
  } else {
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const r = Math.max(bounds.width, bounds.height) / 2;
    grad = context.createRadialGradient(cx, cy, 0, cx, cy, r);
  }
  for (const stop of gradient.stops) {
    grad.addColorStop(stop.offset, stop.color);
  }
  return grad;
}

function parseCanvasColor(
  hex: string,
): readonly [number, number, number, number] | undefined {
  const color = hex.trim().toLowerCase();
  if (color === "transparent") return [0, 0, 0, 0];
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return [
      Number.parseInt(color.charAt(1).repeat(2), 16),
      Number.parseInt(color.charAt(2).repeat(2), 16),
      Number.parseInt(color.charAt(3).repeat(2), 16),
      255,
    ];
  }
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(color)) {
    return [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
      color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) : 255,
    ];
  }
  const match =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(
      color,
    );
  if (match) {
    return [
      Math.max(0, Math.min(255, Number(match[1]))),
      Math.max(0, Math.min(255, Number(match[2]))),
      Math.max(0, Math.min(255, Number(match[3]))),
      Math.max(0, Math.min(255, match[4] === undefined ? 255 : Number(match[4]) * 255)),
    ];
  }
  return undefined;
}
