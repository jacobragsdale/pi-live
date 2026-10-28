/** @type {import("prettier").Config} */
const config = {
  printWidth: 200, // Prefer lines up to the house width before wrapping.
  trailingComma: "none", // Remove trailing commas from multiline structures.
  objectWrap: "collapse" // Collapse existing multiline objects when they fit.
};

export default config;
