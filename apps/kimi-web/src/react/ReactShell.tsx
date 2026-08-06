import { LegacyVueIsland } from "./LegacyVueIsland";
import { InternalBuildBanner } from "./InternalBuildBanner";

/** React-owned application shell during the Vue-to-React strangler migration. */
export function ReactShell(): React.ReactElement {
  return (
    <>
      <LegacyVueIsland />
      <InternalBuildBanner />
    </>
  );
}
