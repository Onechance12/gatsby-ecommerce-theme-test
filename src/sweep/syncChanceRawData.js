import path from "node:path";
import { ReadOnlyJobNimbusClient } from "../jobnimbus/client.js";
import { OPERATIONAL_DOCUMENT_CONTENT_TYPES, PHOTO_CONTENT_TYPES, documentFilterSummary, isOperationalDocument } from "../jobnimbus/documentFilters.js";
import { findChanceUserIds, isChanceContact } from "../lib/chanceScope.js";
import { writeJson } from "../lib/io.js";

export async function syncChanceRawData(config) {
  if (config.useFixtures) {
    throw new Error("Chance scoped live sync requires live JobNimbus data. Use normal fixture sweep for sample data.");
  }

  const client = new ReadOnlyJobNimbusClient(config);
  const syncStartedAt = new Date().toISOString();

  const contactsResult = await client.listResourceWithMeta("contacts", config.endpoints.contacts);
  const jobsResult = await client.listResourceWithMeta("jobs", config.endpoints.jobs);
  const accountSettingsResult = await safeList(client, config, "accountSettings", config.metadataEndpoints.accountSettings);
  const accountUsersResult = await safeList(client, config, "accountUsers", config.metadataEndpoints.accountUsers);

  const chanceUserIds = findChanceUserIds(accountUsersResult.rows);
  const contacts = contactsResult.rows.filter((contact) => isChanceContact(contact, chanceUserIds));
  const contactIds = contacts.map((contact) => contact.jnid || contact.id).filter(Boolean).map(String);

  const related = {
    tasks: await fetchRelatedForContacts(client, config, "tasks", config.endpoints.tasks, contactIds),
    activities: await fetchRelatedForContacts(client, config, "activities", config.endpoints.activities, contactIds),
    documents: await fetchOperationalDocumentsForContacts(client, config, contactIds),
    payments: await fetchRelatedForContacts(client, config, "payments", config.endpoints.payments, contactIds)
  };

  const raw = {
    contacts,
    jobs: jobsResult.rows.filter((job) => contactIds.includes(String(job.contactId || job.customerId || job.contact_id || job.customer || ""))),
    tasks: related.tasks.rows,
    activities: related.activities.rows,
    documents: related.documents.rows,
    payments: related.payments.rows,
    accountSettings: accountSettingsResult.rows,
    accountUsers: accountUsersResult.rows
  };

  const scopeRawDir = path.join(config.paths.rawDir, "chance");
  for (const [name, value] of Object.entries(raw)) {
    writeJson(path.join(scopeRawDir, `${name}.json`), value);
  }

  const syncMeta = {
    syncedAt: syncStartedAt,
    completedAt: new Date().toISOString(),
    mode: "live API",
    scope: "Chance Pearson",
    readOnly: true,
    pageSize: config.pageSize,
    resultWindowLimit: config.resultWindowLimit,
    complete: [
      contactsResult.meta,
      jobsResult.meta,
      accountSettingsResult.meta,
      accountUsersResult.meta,
      related.tasks.meta,
      related.activities.meta,
      related.documents.meta,
      related.payments.meta
    ].every((resource) => resource.complete !== false),
    scopeSelection: {
      owner: "Chance Pearson",
      chanceUserIds: [...chanceUserIds],
      sourceContactsFetched: contactsResult.rows.length,
      chanceContacts: contacts.length
    },
    resources: {
      contactsSource: contactsResult.meta,
      contacts: {
        name: "contacts",
        endpoint: config.endpoints.contacts,
        fetched: contacts.length,
        complete: contactsResult.meta.complete,
        stoppedReason: contactsResult.meta.stoppedReason,
        sourceTotal: contactsResult.meta.total
      },
      jobs: jobsResult.meta,
      tasks: related.tasks.meta,
      activities: related.activities.meta,
      documents: related.documents.meta,
      payments: related.payments.meta,
      accountSettings: accountSettingsResult.meta,
      accountUsers: accountUsersResult.meta
    }
  };

  writeJson(path.join(scopeRawDir, "sync-meta.json"), syncMeta);

  return { raw, syncMeta, scopeRawDir };
}

async function fetchRelatedForContacts(client, config, name, endpoint, contactIds) {
  const rowsById = new Map();
  const perContact = [];

  for (const contactId of contactIds) {
    const result = await client.listResourceWithMeta(name, endpoint, { related: contactId });
    for (const row of result.rows) {
      rowsById.set(rowId(row), row);
    }
    perContact.push({
      contactId,
      fetched: result.meta.fetched,
      total: result.meta.total,
      complete: result.meta.complete,
      stoppedReason: result.meta.stoppedReason
    });
  }

  const incomplete = perContact.filter((entry) => entry.complete === false);
  return {
    rows: [...rowsById.values()],
    meta: {
      name,
      endpoint,
      queryStrategy: "per_contact_related",
      contactsQueried: contactIds.length,
      fetched: rowsById.size,
      complete: incomplete.length === 0,
      stoppedReason: incomplete.length ? "one_or_more_related_queries_partial" : "all_related_queries_complete",
      incompleteContacts: incomplete,
      perContact
    }
  };
}

async function fetchOperationalDocumentsForContacts(client, config, contactIds) {
  const endpoint = config.endpoints.documents;
  const rowsById = new Map();
  const perContact = [];

  for (const contactId of contactIds) {
    const operationalResult = await client.listResourceWithMeta("documents", endpoint, {
      related: contactId,
      filter: JSON.stringify({ must: [{ terms: { content_type: OPERATIONAL_DOCUMENT_CONTENT_TYPES } }] })
    });
    const fetchedForContact = operationalResult.rows;

    const photoResult = await countRelatedDocuments(client, config, endpoint, contactId, PHOTO_CONTENT_TYPES);
    const photoQuery = {
      related: contactId,
      filter: JSON.stringify({ must: [{ terms: { content_type: PHOTO_CONTENT_TYPES } }] })
    };

    const summary = documentFilterSummary(fetchedForContact);
    const keptForContact = fetchedForContact.filter(isOperationalDocument);
    for (const row of keptForContact) {
      rowsById.set(rowId(row), row);
    }

    perContact.push({
      contactId,
      operationalFetched: fetchedForContact.length,
      operationalKept: keptForContact.length,
      operationalDuplicateOrExcluded: fetchedForContact.length - keptForContact.length,
      photoCount: photoResult.total,
      filterSummary: summary,
      operationalQuery: {
        fetched: operationalResult.meta.fetched,
        total: operationalResult.meta.total,
        complete: operationalResult.meta.complete,
        stoppedReason: operationalResult.meta.stoppedReason
      },
      photoCountQuery: {
        total: photoResult.total,
        complete: photoResult.complete,
        stoppedReason: photoResult.stoppedReason,
        query: photoQuery
      }
    });
  }

  const incomplete = perContact.filter((entry) => (
    entry.operationalQuery.complete === false
    || entry.photoCountQuery.complete === false
  ));

  return {
    rows: [...rowsById.values()],
    meta: {
      name: "documents",
      endpoint,
      queryStrategy: "per_contact_operational_content_type",
      contactsQueried: contactIds.length,
      fetched: rowsById.size,
      complete: incomplete.length === 0,
      stoppedReason: incomplete.length ? "one_or_more_document_queries_partial" : "all_operational_document_queries_complete",
      operationalContentTypes: OPERATIONAL_DOCUMENT_CONTENT_TYPES,
      photoContentTypesCountedOnly: PHOTO_CONTENT_TYPES,
      totalPhotoRecordsCounted: perContact.reduce((total, entry) => total + entry.photoCount, 0),
      incompleteContacts: incomplete,
      perContact
    }
  };
}

async function safeList(client, config, name, endpoint) {
  try {
    return await client.listResourceWithMeta(name, endpoint);
  } catch (error) {
    return {
      rows: [{ optional: true, error: config.redact(error.message) }],
      meta: {
        name,
        endpoint,
        optional: true,
        complete: false,
        stoppedReason: "endpoint_error",
        error: config.redact(error.message)
      }
    };
  }
}

async function countRelatedDocuments(client, config, endpoint, contactId, contentTypes) {
  try {
    const payload = await client.getJson(endpoint, {
      related: contactId,
      size: 1,
      from: 0,
      filter: JSON.stringify({ must: [{ terms: { content_type: contentTypes } }] })
    });
    return {
      total: typeof payload?.count === "number" ? payload.count : 0,
      complete: true,
      stoppedReason: "count_probe"
    };
  } catch (error) {
    return {
      total: 0,
      complete: false,
      stoppedReason: "count_probe_error",
      error: config.redact(error.message)
    };
  }
}

function rowId(row) {
  return String(row?.jnid || row?.id || row?.recid || JSON.stringify(row));
}
