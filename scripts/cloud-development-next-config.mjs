// Used only in the isolated development Cloud Run build context.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
if (process.env.LUMA_DEPLOYMENT_ENV !== "development") {
  throw new Error("This build configuration is for the development deployment only.");
}

const config = {
  output: "standalone",
  outputFileTracingRoot: root,
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "googleapis", "@react-pdf/renderer"],
  outputFileTracingIncludes: {
    "/*": ["./src/lib/pdf/fonts/*.ttf", "./node_modules/.prisma/client/**/*"],
  },
};

export default config;
