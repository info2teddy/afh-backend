// src/lib/employeeScope.js
// What a caregiver's own login (role: "employee", see routes/employeeRestrict.js)
// is allowed to touch: their primary home plus any homes they're assigned to
// float to (EmployeeHomeAssignment — the same set Timekeeping already uses
// for a caregiver who works across homes). Every route this login reaches
// must filter through this, not just tenantId — an "employee" login is
// scoped to a slice of the tenant, unlike every other role.
async function assignedHomeIds(prisma, employeeId) {
  const [employee, assignments] = await Promise.all([
    prisma.employee.findUnique({ where: { id: employeeId }, select: { homeId: true } }),
    prisma.employeeHomeAssignment.findMany({ where: { employeeId }, select: { homeId: true } }),
  ]);
  return [...new Set([employee?.homeId, ...assignments.map((a) => a.homeId)].filter(Boolean))];
}

module.exports = { assignedHomeIds };
