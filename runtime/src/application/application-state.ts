export const ApplicationState = {
  Launching: "launching",
  Foreground: "foreground",
  Background: "background",
  Suspended: "suspended",
  Terminating: "terminating",
  Stopped: "stopped",
  Failed: "failed",
} as const;

export type ApplicationState = (typeof ApplicationState)[keyof typeof ApplicationState];

export const isApplicationState = (value: unknown): value is ApplicationState => {
  return (
    typeof value === "string" &&
    Object.values(ApplicationState).includes(value as ApplicationState)
  );
};
