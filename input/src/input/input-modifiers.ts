export interface InputModifiers {
  readonly alt: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
}

export const NO_INPUT_MODIFIERS: InputModifiers = Object.freeze({
  alt: false,
  control: false,
  meta: false,
  shift: false,
});

export function createInputModifiers(
  modifiers: Partial<InputModifiers> = {},
): InputModifiers {
  return Object.freeze({
    alt: modifiers.alt ?? false,
    control: modifiers.control ?? false,
    meta: modifiers.meta ?? false,
    shift: modifiers.shift ?? false,
  });
}
