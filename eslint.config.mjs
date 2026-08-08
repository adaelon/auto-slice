import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["artifacts/**", "coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs}"],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
