import { BrowserRouter } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { AppRouter } from "./router";

export function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <Sidebar />
        <main className="main-content">
          <AppRouter />
        </main>
      </div>
    </BrowserRouter>
  );
}
