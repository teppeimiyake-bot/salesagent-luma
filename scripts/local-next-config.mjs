// Configuration used exclusively by the local development launcher.
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV !== "development") throw Error("Local development configuration only");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.join(root, ".verification/generated/client/index.js");
const localDeps = path.join(root, ".verification/local-deps/node_modules");

const config = {
  distDir: ".verification/next-app",
  typescript: { tsconfigPath: ".verification/tsconfig.app.json" },
  outputFileTracingRoot: root,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  webpack(config, { isServer }) {
    config.resolve.alias["react-markdown"] = path.join(localDeps, "react-markdown/index.js");
    if (isServer) {
      config.externals = [({ request }, callback) => {
        if (request === "@prisma/client" || request === client) return callback(null, `commonjs ${client}`);
        if (request === "googleapis") return callback(null, `commonjs ${path.join(localDeps, "googleapis/build/src/index.js")}`);
        callback();
      }, ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean))];
    }
    return config;
  },
};

export default config;
