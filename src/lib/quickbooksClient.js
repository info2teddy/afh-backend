// src/lib/quickbooksClient.js
// Combines quickbooks_invoice_push.js and quickbooks_payroll_sync.js into one
// module that the invoices and payroll routes call directly.

const QBO_API_BASE = "https://sandbox-quickbooks.api.intuit.com/v3/company";

async function qboRequest(realmId, getAccessToken, path, options = {}) {
  const accessToken = await getAccessToken();
  const res = await fetch(`${QBO_API_BASE}/${realmId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`QuickBooks API error ${res.status}: ${await res.text()}`);
  return res.json();
}

// invoice: { qboCustomerId, periodStart, internalInvoiceId, qboLocationId, lineItems: [{ description, amount, qboItemId }] }
async function pushInvoice(realmId, getAccessToken, invoice) {
  const payload = {
    CustomerRef: { value: invoice.qboCustomerId },
    TxnDate: invoice.periodStart,
    Line: invoice.lineItems.map((item) => ({
      Amount: round2(item.amount),
      DetailType: "SalesItemLineDetail",
      Description: item.description,
      SalesItemLineDetail: { ItemRef: { value: item.qboItemId } },
    })),
    PrivateNote: `AFH-system invoice ref: ${invoice.internalInvoiceId}`,
    ...(invoice.qboLocationId ? { DepartmentRef: { value: invoice.qboLocationId } } : {}),
    // QuickBooks calls this feature "Locations" in the UI but the API field is
    // DepartmentRef either way — this is what enables P&L by branch.
  };

  const result = await qboRequest(realmId, getAccessToken, "/invoice?minorversion=65", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return {
    qboInvoiceId: result.Invoice.Id,
    qboSyncToken: result.Invoice.SyncToken,
  };
}

// shift: { qboEmployeeId, date, hours, payrollItem, qboLocationId }
async function pushTimeActivity(realmId, getAccessToken, shift) {
  const payload = {
    NameOf: "Employee",
    EmployeeRef: { value: shift.qboEmployeeId },
    TxnDate: shift.date,
    Hours: Math.floor(shift.hours),
    Minutes: Math.round((shift.hours % 1) * 60),
    BillableStatus: "NotBillable",
    Description: shift.payrollItem,
    ...(shift.qboLocationId ? { DepartmentRef: { value: shift.qboLocationId } } : {}),
  };

  const result = await qboRequest(realmId, getAccessToken, "/timeactivity?minorversion=65", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return { qboTimeActivityId: result.TimeActivity.Id };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { pushInvoice, pushTimeActivity };
