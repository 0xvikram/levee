import { usePath } from "./components/router";
import { Landing } from "./pages/Landing";
import { Live } from "./pages/Live";
import { Logos } from "./pages/Logos";

export function App() {
  const path = usePath().replace(/\/+$/, "") || "/";
  if (path === "/live") return <Live />;
  if (path === "/logos") return <Logos />;
  return <Landing />;
}
