import { createElement, type ReactElement } from "react";
import { NativeIcon, type NativeComponentProps } from "./primitives.js";

export interface IconProps {
  readonly name: string;
  readonly size?: number;
  readonly color?: string;
  readonly style?: unknown;
}

function createIconComponent(prefix: string) {
  return function IconComponent(props: IconProps): ReactElement {
    return createElement(NativeIcon, {
      icon: props.name,
      role: "image",
      style: [
        {
          width: props.size ?? 24,
          height: props.size ?? 24,
          color: props.color ?? "#FFFFFF",
          fontFamily: prefix,
        },
        props.style,
      ],
    } as unknown as NativeComponentProps);
  };
}

export const Ionicons = createIconComponent("ion");
export const MaterialIcons = createIconComponent("material");
export const MaterialCommunityIcons = createIconComponent("material-community");
export const Feather = createIconComponent("feather");
export const FontAwesome = createIconComponent("fa");
export const FontAwesome5 = createIconComponent("fa5");
export const FontAwesome6 = createIconComponent("fa6");
export const AntDesign = createIconComponent("antdesign");
export const Entypo = createIconComponent("entypo");
export const EvilIcons = createIconComponent("evilicons");
export const Fontisto = createIconComponent("fontisto");
export const Foundation = createIconComponent("foundation");
export const Octicons = createIconComponent("octicons");
export const SimpleLineIcons = createIconComponent("simple-line-icons");
export const Zocial = createIconComponent("zocial");

export function createIconSet(
  _glyphMap: Record<string, number | string>,
  fontFamily: string,
  fontFile?: string,
) {
  return function GenericIcon(props: IconProps): ReactElement {
    return createElement(NativeIcon, {
      icon: props.name,
      role: "image",
      fontFile,
      style: [
        {
          width: props.size ?? 24,
          height: props.size ?? 24,
          color: props.color ?? "#FFFFFF",
          fontFamily,
        },
        props.style,
      ],
    } as unknown as NativeComponentProps);
  };
}
