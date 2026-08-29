// prisma/seed.js
// Run with: npm run seed
// Creates one complete tenant with enough real data to actually test the app:
// a home, a rate schedule, one resident, one employee, and a login to use.

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.create({
    data: { name: "Willow Creek AFH" },
  });
  console.log(`Created tenant: ${tenant.name} (${tenant.id})`);

  const home = await prisma.home.create({
    data: {
      tenantId: tenant.id,
      name: "Willow Creek Main House",
      licenseNumber: "AFH-000001",
      address: "123 Willow Creek Rd, Mill Creek, WA",
      capacity: 6,
    },
  });

  // Rate schedule — care level 2, effective today
  await prisma.rateSchedule.create({
    data: {
      tenantId: tenant.id,
      homeId: home.id,
      careLevel: "level_2",
      monthlyRate: 1600.0,
      roomAndBoardRate: 1200.0,
      effectiveDate: new Date(),
    },
  });

  const resident = await prisma.resident.create({
    data: {
      tenantId: tenant.id,
      homeId: home.id,
      name: "Resident A",
      careLevel: "level_2",
      payerType: "split",
      medicaidSplitPct: 70,
      moveInDate: new Date("2026-08-11"),
      status: "active",
    },
  });

  const employee = await prisma.employee.create({
    data: {
      tenantId: tenant.id,
      homeId: home.id,
      name: "Priya Patel",
      role: "caregiver",
      hireDate: new Date("2025-01-15"),
      payRate: 24.0,
      employmentType: "hourly",
      liveIn: true,
    },
  });

  await prisma.credential.create({
    data: {
      tenantId: tenant.id,
      employeeId: employee.id,
      credentialType: "cpr_first_aid",
      issueDate: new Date("2025-08-01"),
      expirationDate: new Date("2026-09-02"), // intentionally close, to test the alert
    },
  });

  const passwordHash = await bcrypt.hash("changeme123", 12);
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: "admin@willowcreek.example",
      passwordHash,
      role: "admin", // admin role so this account can create logins for other users via /auth/users
    },
  });

  console.log("\nSeed complete. Log in with:");
  console.log(`  email:    ${user.email}`);
  console.log(`  password: changeme123`);
  console.log(`\nTenant ID (for reference): ${tenant.id}`);
  console.log("Change the seeded password before using this anywhere real.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
