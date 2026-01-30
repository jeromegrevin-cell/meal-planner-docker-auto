import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiKey = env.MEAL_PLANNER_API_KEY || process.env.MEAL_PLANNER_API_KEY;
  const apiTarget = (env.VITE_API_URL || "http://127.0.0.1:3002").replace(
    /\/api\/?$/,
    ""
  );
  const host = env.VITE_HOST || "0.0.0.0";

  return {
    plugins: [react()],
    server: {
      host,
      port: 5174,
      proxy: {
        "/api": {
          target: apiTarget,
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
