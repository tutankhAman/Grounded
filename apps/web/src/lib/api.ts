import { treaty } from "@elysiajs/eden";
import type { App } from "@grounded/api";

const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";

export const api = treaty<App>(apiUrl);
