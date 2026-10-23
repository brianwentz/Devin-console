import { setSettingsTab } from '../store';
import { requestSurface } from '../surface';

// The two ways out of a signed-out OpenHands state, shared by the sidebar
// banner and the Analytics -> OpenHands hints.

/** Shows the OpenHands home page (its own sign-in flow). */
export const openOpenHandsSignIn = (): void => window.agentworkspace.openhandsOpenHome();

/** Settings -> OpenHands (the API key). */
export const openOpenHandsSettings = (): void => {
  setSettingsTab('openhands');
  void requestSurface('settings');
};
