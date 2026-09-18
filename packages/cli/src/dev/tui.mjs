// The operator console lives in TSX. Importing the loader first (a static
// import, so its body runs before this module's) registers the JSX transform;
// the dynamic import below then resolves the console itself.
import "./tsx-loader.mjs";

const console_ = await import("./tui/index.tsx");

export const renderDevDashboard = console_.renderDevDashboard;
export const renderLauncher = console_.renderLauncher;
export const runDevTui = console_.runDevTui;
export const runLauncherTui = console_.runLauncherTui;
export const devKeymapEntries = console_.devKeymapEntries;
export const footerText = console_.footerText;
export const helpBindings = console_.helpBindings;
export const paletteItems = console_.paletteItems;
export const layoutPlan = console_.layoutPlan;
