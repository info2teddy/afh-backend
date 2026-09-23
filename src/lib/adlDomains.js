// src/lib/adlDomains.js
// The 9 ADL domains used by both the Negotiated Care Plan's ADL table (see
// buildPrompt in routes/carePlans.js) and the caregiver-logged ADL checklist
// (routes/residents.js's /:id/adl routes) — one list, so the checklist a
// caregiver taps through can never drift from what the actual care plan
// document says a resident needs. Order matches the DSHS template's own
// layout, preserved here too since the checklist UI follows the same order.
const ADL_DOMAINS = [
  "Ambulation/Mobility",
  "Bed Mobility/Transfer",
  "Eating",
  "Toileting/Continence",
  "Dressing",
  "Personal Hygiene",
  "Bathing",
  "Foot Care",
  "Skin Care",
];

module.exports = { ADL_DOMAINS };
