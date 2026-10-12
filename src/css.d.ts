// The CSS-Modules build turns this sheet into a hashed class map AND injects it
// at materialization. The binding is what the component reads; importing it for
// side effects only would leave `styles` undefined at render time.
declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}