import { dateOnly, parseDate } from "../lib/dates.js";

export function normalizeFiles(raw) {
  const contacts = raw.contacts || [];
  const jobs = raw.jobs || [];
  const tasks = raw.tasks || [];
  const notes = raw.notes || [];
  const activities = raw.activities || [];
  const documents = raw.documents || raw.files || [];
  const payments = raw.payments || [];

  const contactById = new Map(contacts.map((contact) => [idOf(contact), contact]));

  const jobFiles = jobs.map((job) => {
    const contact = contactById.get(job.contactId || job.customerId || job.contact_id || job.customer) || {};
    return normalizeRecordFile({
      record: job,
      contact,
      sourceType: "job",
      tasks,
      notes,
      activities,
      documents,
      payments
    });
  });

  const jobCustomerIds = new Set(jobs.flatMap((job) => [
    job.customer,
    job.contactId,
    job.customerId,
    job.contact_id
  ]).filter(Boolean).map(String));
  const contactFiles = contacts
    .filter((contact) => shouldTreatContactAsFile(contact, jobCustomerIds))
    .map((contact) => normalizeRecordFile({
      record: contact,
      contact,
      sourceType: "contact",
      tasks,
      notes,
      activities,
      documents,
      payments
    }));

  return { files: [...contactFiles, ...jobFiles] };
}

function normalizeRecordFile({ record, contact, sourceType, tasks, notes, activities, documents, payments }) {
  const recordId = idOf(record);
  const recordIds = idsOf(record);
  const relatedTasks = tasks.filter((task) => relatesTo(task, recordIds));
  const relatedNotes = notes.filter((note) => relatesTo(note, recordIds));
  const relatedActivities = activities.filter((activity) => relatesTo(activity, recordIds));
  const relatedDocuments = documents.filter((document) => relatesTo(document, recordIds));
  const relatedPayments = payments.filter((payment) => relatesTo(payment, recordIds));

  return {
    id: recordId,
    number: pick(record.number, record.recid),
    sourceType,
    customer: displayName(contact, record),
    address: addressOf(contact, record),
    email: pick(contact.email, record.email, pickField(record, ["Email", "Email Address"])),
    phone: pick(
      contact.mobile_phone,
      contact.home_phone,
      contact.work_phone,
      record.mobile_phone,
      record.home_phone,
      record.work_phone,
      pickField(record, ["Mobile", "Mobile Phone", "Phone", "Main Phone", "Home Phone", "Cell Phone"])
    ),
    mobilePhone: pick(contact.mobile_phone, record.mobile_phone, pickField(record, ["Mobile", "Mobile Phone", "Cell Phone"])),
    homePhone: pick(contact.home_phone, record.home_phone, pickField(record, ["Home Phone"])),
    status: pick(record.status_name, record.status, record.stage, record.workflowStatus, "Unknown"),
    recordType: pick(record.record_type_name, record.type, sourceType),
    carrier: pickField(record, ["carrier", "insuranceCarrier", "Insurance Company", "Insurance Carrier", "Carrier"]),
    claimNumber: pickField(record, ["claimNumber", "claim_number", "Claim Number", "Claim #", "Claim No", "Claim No."]),
    dateOfLoss: dateOnly(pickFieldRaw(record, ["dateOfLoss", "lossDate", "Date of Loss", "DOL", "Loss Date"])),
    adjuster: {
      name: pickField(record, ["adjusterName", "Adjuster Name", "Adjuster", "Carrier DA", "Field Adjuster", "Desk Adjuster"]),
      phone: pickField(record, ["adjusterPhone", "Adjuster Phone", "Adjuster Phone Number", "Carrier DA Contact #", "Field Adjuster Phone"]),
      email: pickField(record, ["adjusterEmail", "Adjuster Email", "Carrier DA Email", "Field Adjuster Email", "Desk Adjuster Email"])
    },
    mortgageCompany: pickField(record, ["mortgageCompany", "Mortgage Company", "Mortgage", "Lienholder"]),
    policyNumber: pickField(record, ["policyNumber", "Policy Number", "Policy #", "Policy No", "Policy No."]),
    typeOfLoss: pickField(record, ["Type Of Loss", "Type of Loss", "Loss Type", "Cause of Loss"]),
    deductibleAmount: pickField(record, ["Deductible Amount", "Deductible"]),
    daysInStatus: pickField(record, ["Days in Status", "daysInStatus"]),
    estimateStatus: pickField(record, ["Estimate Status", "Scope Status", "Estimate", "Scope"]),
    appraisalStatus: pickField(record, ["Appraisal Status", "Appraisal", "Appraisal Demand", "Appraisal Filed"]),
    denialStatus: pickField(record, ["Denial Status", "Denied", "Denial Reason", "Coverage Decision"]),
    deductibleStatus: pickField(record, ["Deductible Status", "Deductible Confirmed", "Deductible"]),
    lastActivityDate: dateOnly(latestDate([
      record.lastActivityDate,
      record.updatedAt,
      record.date_updated,
      ...relatedNotes.map((note) => note.createdAt),
      ...relatedNotes.map((note) => note.date_created),
      ...relatedActivities.map((activity) => activity.createdAt || activity.date_created)
    ])),
    customFields: {
      ...(record.customFields || {}),
      paymentReceived: relatedPayments.length > 0 || record.customFields?.paymentReceived
    },
    openTasks: relatedTasks
      .filter((task) => !isClosed(task.status_name || task.status) && task.is_completed !== true)
      .map((task) => ({
        id: idOf(task),
        title: pick(task.title, task.name, task.subject, "Untitled task"),
        dueDate: dateOnly(task.dueDate || task.date_due || task.date_end || task.date_start),
        assignedTo: pick(task.assignedTo, task.owner, task.assignee, task.owners?.[0]?.name, task.created_by_name)
      })),
    notes: relatedNotes.map((note) => ({
      id: idOf(note),
      createdAt: note.createdAt || note.date_created,
      body: pick(note.body, note.note, note.text)
    })).concat(relatedActivities.map((activity) => ({
      id: idOf(activity),
      createdAt: activity.createdAt || activity.date_created,
      body: pick(activity.body, activity.note, activity.description, activity.record_type_name)
    }))),
    documents: relatedDocuments.map((document) => ({
      id: idOf(document),
      name: pick(document.name, document.filename, document.title, "Document"),
      type: pick(document.type, document.category)
    })),
    payments: relatedPayments.map((payment) => ({
      id: idOf(payment),
      amount: payment.amount || payment.payment_amount || payment.total,
      date: dateOnly(payment.date_created || payment.date || payment.payment_date)
    })),
    source: {
      [sourceType]: record,
      contact
    }
  };
}

function shouldTreatContactAsFile(contact, jobCustomerIds) {
  if (!idOf(contact) || jobCustomerIds.has(idOf(contact))) return false;
  const type = String(contact.record_type_name || contact.type || "").toLowerCase();
  const status = String(contact.status_name || contact.status || "").toLowerCase();
  return type.includes("insurance") ||
    status.includes("appraisal") ||
    status.includes("claim") ||
    status.includes("estimate") ||
    status.includes("photo file");
}

function relatesTo(record, recordIds) {
  const targetIds = new Set(recordIds.map(String).filter(Boolean));
  if ([
    record.jobId,
    record.job_id,
    record.parentId,
    record.parent_id,
    record.relatedId,
    record.related_id,
    record.customer,
    record.primary?.id
  ].filter(Boolean).map(String).some((id) => targetIds.has(id))) {
    return true;
  }

  return Array.isArray(record.related) && record.related.some((related) => targetIds.has(String(related.id)));
}

function idOf(record) {
  return String(record.id || record.jnid || record.jobId || record.contactId || "");
}

function idsOf(record) {
  return [
    record.id,
    record.jnid,
    record.jobId,
    record.contactId
  ].filter(Boolean).map(String);
}

function displayName(contact, job) {
  return pick(
    contact.displayName,
    contact.display_name,
    contact.name,
    [contact.firstName, contact.lastName].filter(Boolean).join(" "),
    [contact.first_name, contact.last_name].filter(Boolean).join(" "),
    job.customerName,
    job.name,
    "Unknown customer"
  );
}

function addressOf(contact, job) {
  const address = contact.address || job.address || job.propertyAddress;
  if (typeof address === "string") return address;
  if (address && typeof address === "object") {
    return [
      address.line1,
      address.line2,
      address.city,
      address.state,
      address.postalCode || address.zip
    ].filter(Boolean).join(", ");
  }
  const lineAddress = [
    job.address_line1 || contact.address_line1,
    job.address_line2 || contact.address_line2,
    job.city || contact.city,
    job.state_text || contact.state_text,
    job.zip || contact.zip
  ].filter(Boolean).join(", ");
  if (lineAddress) return lineAddress;
  return "";
}

function pick(...values) {
  for (const value of values) {
    if (value != null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function pickField(record, aliases) {
  return pick(pickFieldRaw(record, aliases));
}

function pickFieldRaw(record, aliases) {
  for (const alias of aliases) {
    const value = lookupCaseInsensitive(record, alias);
    if (value != null && String(value).trim() !== "") return value;
    const customValue = lookupCaseInsensitive(record.customFields || {}, alias);
    if (customValue != null && String(customValue).trim() !== "") return customValue;
  }
  return "";
}

function lookupCaseInsensitive(record, key) {
  if (!record || typeof record !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  const normalized = normalizeKey(key);
  const foundKey = Object.keys(record).find((candidate) => normalizeKey(candidate) === normalized);
  return foundKey ? record[foundKey] : undefined;
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function latestDate(values) {
  const dates = values
    .filter(Boolean)
    .map((value) => parseDate(value))
    .filter((date) => date && !Number.isNaN(date.getTime()));
  if (!dates.length) return "";
  return new Date(Math.max(...dates.map((date) => date.getTime()))).toISOString();
}

function isClosed(status) {
  return /closed|complete|done|cancel/i.test(status || "");
}
