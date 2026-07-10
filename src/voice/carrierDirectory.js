// Thin re-export. The canonical carrier filing directory now lives in the
// portable claim core (src/claim-filing-core/carrierDirectory.js) so the Render
// bridge can copy it without pulling in the local assistant. Existing call sites
// keep importing from here.
export { lookupCarrier, knownCarriers } from "../claim-filing-core/carrierDirectory.js";
