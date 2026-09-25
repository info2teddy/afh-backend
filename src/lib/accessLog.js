// src/lib/accessLog.js
// Records who opened or changed a resident's record (ResidentAccessLog in
// schema.prisma) — the HIPAA access trail, shown on the resident profile.
//
// Never blocks or fails the request it's recording: the write happens after
// the response is decided and any error is only logged. A missing trail entry
// is bad; a caregiver unable to open a resident's record is worse.

const { prisma } = require("../middleware/tenant");

// Opening a profile fires several reads (profile, face sheet panel, print
// page), so repeat views by the same person within this window count once.
const VIEW_DEDUPE_MS = 10 * 60 * 1000;

async function write(req, residentId, action) {
  if (action === "view") {
    const recent = await prisma.residentAccessLog.findFirst({
      where: {
        tenantId: req.tenantId,
        residentId,
        userId: req.userId,
        action: "view",
        createdAt: { gte: new Date(Date.now() - VIEW_DEDUPE_MS) },
      },
      select: { id: true },
    });
    if (recent) return;
  }
  const user = req.userId
    ? await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true } })
    : null;
  await prisma.residentAccessLog.create({
    data: {
      tenantId: req.tenantId,
      residentId,
      userId: req.userId || null,
      userEmail: user?.email || null,
      userRole: req.userRole || null,
      action,
    },
  });
}

function logAccess(req, residentId, action) {
  write(req, residentId, action).catch((err) =>
    console.error(`[access-log] could not record ${action} on resident ${residentId}: ${err.message}`),
  );
}

module.exports = { logAccess };
