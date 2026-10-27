import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 받아 와서 그대로 두는 외부 번들(pdf.js worker, lcms-wasm, onnxruntime-web wasm 글루)은 검사하지 않는다
    "public/**",
  ]),
]);

export default eslintConfig;
