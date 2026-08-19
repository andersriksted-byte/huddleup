import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages serverer et projekt-repo under https://<bruger>.github.io/<repo-navn>/
// — derfor SKAL "base" matche repo-navnet nøjagtigt (med skråstreger foran og bagved),
// ellers indlæses alle JS/CSS-filer fra forkert sti og siden bliver blank.
//
// Repo-navn i dette projekt: "huddleup"
// Hvis du omdøber repoet, så ret linjen herunder til det nye navn.
export default defineConfig({
  plugins: [react()],
  base: "/huddleup/",
  build: {
    outDir: "dist",
  },
});
