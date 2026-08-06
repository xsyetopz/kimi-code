import { createRoot } from "react-dom/client";

import { installClientErrorCapture } from "../debug/trace";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/inter/opsz-italic.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../style.css";
import { ReactShell } from "./ReactShell";

// Always retain bounded metadata for uncaught failures. With ?debug=1 / the
// debug flag, console output is included too; HMR restores listeners/wrappers.
installClientErrorCapture();

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) {
  throw new Error("Kimi web root #app is missing");
}

createRoot(root).render(<ReactShell />);
