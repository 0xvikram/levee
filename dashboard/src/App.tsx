import { usePath } from "./components/router";
import { Landing } from "./pages/Landing";
import { Live } from "./pages/Live";

export function App() {
  const path = usePath().replace(/\/+$/, "") || "/";
  if (path === "/live") return <Live />;
  return <Landing />;
}
