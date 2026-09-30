// electron.vite.config.ts
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// src/main/auth/config.ts
function isPublicKey(key) {
  if (key.startsWith("sb_publishable_")) return key.length > 20;
  try {
    return JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "anon";
  } catch {
    return false;
  }
}

// electron.vite.config.ts
var __electron_vite_injected_dirname = "/Users/a1234/Desktop/Mix";
var electron_vite_config_default = defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ["MAIN_VITE_"]);
  const key = env.MAIN_VITE_SUPABASE_PUBLISHABLE_KEY;
  if (key && !isPublicKey(key)) throw new Error("Auth build requires a publishable or anon key");
  return {
    main: {
      resolve: {
        alias: { "@main": resolve(__electron_vite_injected_dirname, "src/main") }
      }
    },
    preload: {
      resolve: {
        alias: { "@preload": resolve(__electron_vite_injected_dirname, "src/preload") }
      }
    },
    renderer: {
      resolve: {
        alias: {
          "@renderer": resolve(__electron_vite_injected_dirname, "src/renderer/src")
        }
      },
      plugins: [react(), tailwindcss()]
    }
  };
});
export {
  electron_vite_config_default as default
};
