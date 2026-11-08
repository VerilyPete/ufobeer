// Vite's ?raw suffix imports a file's contents as a string. Declared here so
// the contract typecheck does not depend on the fixture files existing.
declare module '*?raw' {
  const content: string;
  export default content;
}
