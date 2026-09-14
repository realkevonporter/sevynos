import type {
  AccessibilityNode,
  NativeBounds,
  NativeControlAction,
  NativeCornerRadii,
  NativeGradient,
  NativeGradientStop,
  NativeRenderCommand,
  NativeRuntimeSnapshot,
  NativeShadow,
  StructuredValue,
} from "@sevynos/react-native/internal";

export function decodeWorkerSurface(surface: {
  readonly revision: number;
  readonly commands: readonly StructuredValue[];
  readonly accessibility: readonly StructuredValue[];
}): NativeRuntimeSnapshot {
  const commands = surface.commands.map(decodeCommand);
  const accessibility = surface.accessibility.map(decodeAccessibility);
  return Object.freeze({
    revision: surface.revision,
    commands: Object.freeze(commands),
    accessibility: Object.freeze(accessibility),
    overlays: Object.freeze([]),
    changedNodeIds: Object.freeze(commands.map((command) => command.id)),
  });
}
function decodeCommand(value: StructuredValue): NativeRenderCommand {
  const item = structuredRecord(value, "surface command");
  const kind = string(item, "kind");
  const opacity = optionalNumber(item, "opacity");
  const base = {
    id: string(item, "id"),
    bounds: bounds(item["bounds"]),
    ...(opacity === undefined ? {} : { opacity }),
  };
  switch (kind) {
    case "material": {
      const borderColor = optionalString(item, "borderColor");
      const borderWidth = optionalNumber(item, "borderWidth");
      const borderStyle = optionalString(item, "borderStyle");
      const blur = optionalNumber(item, "blur");
      const backdropBlur = optionalNumber(item, "backdropBlur");
      const radii = decodeRadii(item["radii"]);
      const shadow = decodeShadow(item["shadow"]);
      const gradient = decodeGradient(item["gradient"]);
      return Object.freeze({
        ...base,
        kind,
        color: string(item, "color"),
        radius: number(item, "radius"),
        ...(borderColor === undefined ? {} : { borderColor }),
        ...(borderWidth === undefined ? {} : { borderWidth }),
        ...(borderStyle === "solid" ||
        borderStyle === "dotted" ||
        borderStyle === "dashed"
          ? { borderStyle }
          : {}),
        ...(radii === undefined ? {} : { radii }),
        ...(shadow === undefined ? {} : { shadow }),
        ...(blur === undefined ? {} : { blur }),
        ...(backdropBlur === undefined ? {} : { backdropBlur }),
        ...(gradient === undefined ? {} : { gradient }),
      });
    }
    case "text": {
      const lineHeight = optionalNumber(item, "lineHeight");
      const letterSpacing = optionalNumber(item, "letterSpacing");
      const fontFamily = optionalString(item, "fontFamily");
      const fontStyle = optionalString(item, "fontStyle");
      const wrap = optionalBoolean(item, "wrap");
      const align = optionalString(item, "align");
      return Object.freeze({
        ...base,
        kind,
        text: string(item, "text"),
        color: string(item, "color"),
        size: number(item, "size"),
        weight: number(item, "weight"),
        ...(align === "start" || align === "center" || align === "end" ? { align } : {}),
        ...(lineHeight === undefined ? {} : { lineHeight }),
        ...(letterSpacing === undefined ? {} : { letterSpacing }),
        ...(fontFamily === undefined ? {} : { fontFamily }),
        ...(fontStyle === "normal" || fontStyle === "italic" ? { fontStyle } : {}),
        ...(wrap === undefined ? {} : { wrap }),
      });
    }
    case "separator":
      return Object.freeze({ ...base, kind, color: string(item, "color") });
    case "clip-start":
    case "clip-end":
      return Object.freeze({ ...base, kind });
    case "icon": {
      const icon = string(item, "icon");
      if (!isIcon(icon)) throw new Error(`Worker icon "${icon}" is unsupported.`);
      return Object.freeze({ ...base, kind, icon, color: string(item, "color") });
    }
    case "control": {
      const action = string(item, "action");
      const state = string(item, "state");
      if (!isAction(action) || !isInteractionState(state))
        throw new Error("Worker control command contains unsupported values.");
      const borderWidth = optionalNumber(item, "borderWidth");
      const borderColor = optionalString(item, "borderColor");
      const shadow = decodeShadow(item["shadow"]);
      return Object.freeze({
        ...base,
        kind,
        action,
        label: string(item, "label"),
        value: string(item, "value"),
        state,
        accent: string(item, "accent"),
        foreground: string(item, "foreground"),
        background: string(item, "background"),
        radius: number(item, "radius"),
        ...(borderWidth === undefined ? {} : { borderWidth }),
        ...(borderColor === undefined ? {} : { borderColor }),
        ...(shadow === undefined ? {} : { shadow }),
      });
    }
    case "gradient": {
      const grad = decodeGradient(item["gradient"]);
      if (grad === undefined)
        throw new Error("Worker gradient command missing valid gradient.");
      const radii = decodeRadii(item["radii"]);
      const borderColor = optionalString(item, "borderColor");
      const borderWidth = optionalNumber(item, "borderWidth");
      return Object.freeze({
        ...base,
        kind,
        gradient: grad,
        radius: number(item, "radius"),
        ...(radii === undefined ? {} : { radii }),
        ...(borderColor === undefined ? {} : { borderColor }),
        ...(borderWidth === undefined ? {} : { borderWidth }),
      });
    }
    case "bitmap": {
      const pixelsValue = item["pixels"];
      if (!(pixelsValue instanceof Uint8Array))
        throw new Error("Worker bitmap pixels must be a Uint8Array.");
      return Object.freeze({
        ...base,
        kind,
        width: number(item, "width"),
        height: number(item, "height"),
        pixels: pixelsValue,
      });
    }
    default:
      throw new Error(`Worker render command "${kind}" is unsupported.`);
  }
}
function decodeAccessibility(value: StructuredValue): AccessibilityNode {
  const item = structuredRecord(value, "accessibility node");
  const role = string(item, "role");
  if (!isRole(role))
    throw new Error(`Worker accessibility role "${role}" is unsupported.`);
  const childrenValue = item["children"];
  if (!Array.isArray(childrenValue))
    throw new Error("Worker accessibility children must be an array.");
  const description = optionalString(item, "description");
  return Object.freeze({
    id: string(item, "id"),
    role,
    label: string(item, "label"),
    ...(description === undefined ? {} : { description }),
    disabled: boolean(item, "disabled"),
    selected: boolean(item, "selected"),
    ...(typeof item["checked"] === "boolean" ? { checked: item["checked"] } : {}),
    focusOrder: number(item, "focusOrder"),
    bounds: bounds(item["bounds"]),
    children: Object.freeze(childrenValue.map(decodeAccessibility)),
  });
}
function bounds(value: StructuredValue | undefined): NativeBounds {
  const item = structuredRecord(value, "bounds");
  const result = {
    x: number(item, "x"),
    y: number(item, "y"),
    width: number(item, "width"),
    height: number(item, "height"),
  };
  if (result.width < 0 || result.height < 0)
    throw new Error("Worker bounds cannot be negative.");
  return Object.freeze(result);
}
function structuredRecord(
  value: StructuredValue | undefined,
  name: string,
): Readonly<Record<string, StructuredValue>> {
  if (
    value === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  )
    throw new Error(`Worker ${name} must be an object.`);
  const output: Record<string, StructuredValue> = {};
  for (const [key, item] of Object.entries(value)) output[key] = item;
  return output;
}
function string(value: Readonly<Record<string, StructuredValue>>, key: string): string {
  const item = value[key];
  if (typeof item !== "string")
    throw new Error(`Worker field "${key}" must be a string.`);
  return item;
}
function optionalString(
  value: Readonly<Record<string, StructuredValue>>,
  key: string,
): string | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== "string")
    throw new Error(`Worker field "${key}" must be a string.`);
  return item;
}
function number(value: Readonly<Record<string, StructuredValue>>, key: string): number {
  const item = value[key];
  if (typeof item !== "number" || !Number.isFinite(item))
    throw new Error(`Worker field "${key}" must be finite.`);
  return item;
}
function boolean(value: Readonly<Record<string, StructuredValue>>, key: string): boolean {
  const item = value[key];
  if (typeof item !== "boolean")
    throw new Error(`Worker field "${key}" must be boolean.`);
  return item;
}
function optionalNumber(
  value: Readonly<Record<string, StructuredValue>>,
  key: string,
): number | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== "number" || !Number.isFinite(item))
    throw new Error(`Worker field "${key}" must be finite.`);
  return item;
}
function optionalBoolean(
  value: Readonly<Record<string, StructuredValue>>,
  key: string,
): boolean | undefined {
  const item = value[key];
  if (item === undefined) return undefined;
  if (typeof item !== "boolean")
    throw new Error(`Worker field "${key}" must be boolean.`);
  return item;
}
function decodeRadii(value: StructuredValue | undefined): NativeCornerRadii | undefined {
  if (
    value === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const item = value as Record<string, StructuredValue>;
  const topLeft = optionalNumber(item, "topLeft");
  const topRight = optionalNumber(item, "topRight");
  const bottomLeft = optionalNumber(item, "bottomLeft");
  const bottomRight = optionalNumber(item, "bottomRight");
  if (
    topLeft === undefined &&
    topRight === undefined &&
    bottomLeft === undefined &&
    bottomRight === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    ...(topLeft === undefined ? {} : { topLeft }),
    ...(topRight === undefined ? {} : { topRight }),
    ...(bottomLeft === undefined ? {} : { bottomLeft }),
    ...(bottomRight === undefined ? {} : { bottomRight }),
  });
}
function decodeShadow(value: StructuredValue | undefined): NativeShadow | undefined {
  if (
    value === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const item = value as Record<string, StructuredValue>;
  const color = optionalString(item, "color");
  const blur = optionalNumber(item, "blur");
  const y = optionalNumber(item, "y");
  if (color === undefined || blur === undefined || y === undefined) {
    return undefined;
  }
  const x = optionalNumber(item, "x");
  const opacity = optionalNumber(item, "opacity");
  return Object.freeze({
    color,
    blur,
    y,
    ...(x === undefined ? {} : { x }),
    ...(opacity === undefined ? {} : { opacity }),
  });
}
function decodeGradient(value: StructuredValue | undefined): NativeGradient | undefined {
  if (
    value === undefined ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return undefined;
  }
  const item = value as Record<string, StructuredValue>;
  const kind = optionalString(item, "kind");
  if (kind !== "linear" && kind !== "radial") return undefined;
  const rawStops = item["stops"];
  if (!Array.isArray(rawStops)) return undefined;
  const stops: NativeGradientStop[] = (rawStops as readonly StructuredValue[]).map(
    (s: StructuredValue) => {
      const stopRecord = structuredRecord(s, "gradient stop");
      return Object.freeze({
        offset: number(stopRecord, "offset"),
        color: string(stopRecord, "color"),
      });
    },
  );
  if (kind === "linear") {
    const angle = optionalNumber(item, "angle");
    return Object.freeze({
      kind: "linear",
      ...(angle === undefined ? {} : { angle }),
      stops: Object.freeze(stops),
    });
  }
  return Object.freeze({
    kind: "radial",
    stops: Object.freeze(stops),
  });
}
function isInteractionState(
  value: string,
): value is "idle" | "hovered" | "focused" | "pressed" | "disabled" {
  return (
    value === "idle" ||
    value === "hovered" ||
    value === "focused" ||
    value === "pressed" ||
    value === "disabled"
  );
}
function isAction(value: string): value is NativeControlAction {
  return typeof value === "string" && value.length > 0;
}
function isIcon(
  value: string,
): value is
  | "appearance"
  | "color"
  | "display"
  | "workspace"
  | "pointer"
  | "motion"
  | "history"
  | "controls"
  | "gallery"
  | "search" {
  return [
    "appearance",
    "color",
    "display",
    "workspace",
    "pointer",
    "motion",
    "history",
    "controls",
    "gallery",
    "search",
  ].includes(value);
}
function isRole(value: string): value is AccessibilityNode["role"] {
  return [
    "application",
    "button",
    "checkbox",
    "dialog",
    "heading",
    "list",
    "listitem",
    "menu",
    "menuitem",
    "slider",
    "tab",
    "textbox",
  ].includes(value);
}
