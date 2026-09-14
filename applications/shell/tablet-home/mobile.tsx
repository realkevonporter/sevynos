import type { JSX } from "react";
import {
  MobileHomeApplication,
  type MobileApplicationSummary,
} from "../mobile-home/mobile.js";

export interface TabletHomeApplicationProps {
  readonly applications: readonly MobileApplicationSummary[];
  readonly onLaunch: (applicationId: string) => Promise<void>;
}

export function TabletHomeApplication(props: TabletHomeApplicationProps): JSX.Element {
  return <MobileHomeApplication {...props} />;
}
