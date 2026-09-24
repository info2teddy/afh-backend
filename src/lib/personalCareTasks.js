// src/lib/personalCareTasks.js
// The daily charting categories on the real paper "Personal Care Record"
// (Form A-55) the user's AFH binders use — a per-shift task log, distinct
// from lib/adlDomains.js (the Negotiated Care Plan's own 9 ADL/assessment
// domains, a different real document serving a different purpose: what's
// prescribed vs. what was actually done each shift). Order matches the
// paper form's own layout.
//
// Deliberately NOT modeled here: the form's per-resident "care profile"
// settings (which bath type, which ambulation aid, feeds self vs. assisted,
// etc. — checked once, not per shift) and its Loss of Senses/Communication
// panel. Those are static resident attributes, closer to the face sheet than
// to a daily log, and weren't asked for — see AdlEntry.note for capturing
// that kind of detail inline instead of building a separate structured model
// for it sight unseen.
const PERSONAL_CARE_TASKS = [
  "Diet",
  "Bath",
  "Oral Care",
  "Fingernail Care",
  "Toenail Care",
  "Shave",
  "Shampoo",
  "Bowel Movement",
  "Incontinence Care",
  "Skin Care/Reposition",
  "Ambulation",
  "Restraints Check",
  "Routine Resident Check",
  "Linen Change",
];

const SHIFTS = ["day", "evening", "night"];

module.exports = { PERSONAL_CARE_TASKS, SHIFTS };
