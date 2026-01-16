import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.MEAL_PLANNER_API_KEY || process.env.MEAL_PLANNER_API_KEY;

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5174,
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3002",
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              if (apiKey) {
                proxyReq.setHeader("x-api-key", apiKey);
              }
            });
          }
        }
      }
    }
  };
});
