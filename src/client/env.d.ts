// Bun bundles a stylesheet a component imports; TypeScript needs to be
// told the import exists and returns nothing.
declare module "*.css" {}

// an image the server serves as a file: the import is its path
declare module "*.png" {
  const path: string;
  export default path;
}
