/**
 * The prebuilt ESM bundle ships in the npm package without its own typings,
 * and its ONLY runtime export is `default` — the whole Tesseract namespace
 * (it wraps the CJS UMD build). Destructure from `.default`, never from the
 * module record itself.
 */
declare module 'tesseract.js/dist/tesseract.esm.min.js' {
  import Tesseract = require('tesseract.js')
  export default Tesseract
}
