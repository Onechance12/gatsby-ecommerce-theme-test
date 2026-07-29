(function () {
  "use strict";

  const ENDPOINTS = Object.freeze({
    meta: "/api/v1/meta",
    session: "/hcn/auth/session",
    logout: "/hcn/auth/logout",
    workCenter: "/hcn/api/v1/work-center",
    fileReview: "/hcn/api/v1/file-review",
    actionPrepare: "/hcn/api/v1/action-plans/prepare",
    actionList: "/hcn/api/v1/action-plans/list",
    actionDetail: "/hcn/api/v1/action-plans/detail",
    actionExecute: "/hcn/api/v1/action-plans/execute",
    actionInvalidate: "/hcn/api/v1/action-plans/invalidate",
    receiptList: "/hcn/api/v1/action-receipts/list",
    receiptDetail: "/hcn/api/v1/action-receipts/detail"
  });

  const WORK_CENTER_CAPABILITY = "hcn.work_center.read";
  const FILE_REVIEW_CAPABILITY = "hcn.file.review";
  const ACTION_PREPARE_CAPABILITY = "hcn.action_plans.prepare";
  const ACTION_READ_CAPABILITY = "hcn.action_plans.read";
  const ACTION_EXECUTE_CAPABILITY = "hcn.action_plans.execute";
  const ACTION_INVALIDATE_CAPABILITY = "hcn.action_plans.invalidate";
  const RECEIPT_READ_CAPABILITY = "hcn.action_receipts.read";
  const FILE_REF = /^subject_[a-f0-9]{32}$/;
  const TASK_REF = /^ref_[a-f0-9]{32}$/;
  const PLAN_ID = /^plan_[a-f0-9]{32}$/;
  const BATCH_REF = /^batch_[a-f0-9]{32}$/;
  const APPROVAL_DIGEST = /^[a-f0-9]{64}$/;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const SESSION_IDLE_HEADER = "x-hcn-session-idle-expires-at";
  const SESSION_ABSOLUTE_HEADER = "x-hcn-session-expires-at";
  const MAX_TIMER_DELAY_MS = 2_147_000_000;
  const MAX_ACTIONS = 12;

  const ACTION_LABELS = Object.freeze({
    "jobnimbus.create_note": "Create JobNimbus note",
    "jobnimbus.create_task": "Create JobNimbus task",
    "jobnimbus.update_task": "Update JobNimbus task",
    "jobnimbus.update_status": "Change JobNimbus status",
    "jobnimbus.update_contact": "Set JobNimbus date of loss"
  });

  const PLAN_STATUSES = new Set([
    "pending",
    "executing",
    "executed",
    "completed_pending_verification",
    "partial_failure",
    "blocked_duplicate",
    "failed",
    "reconciliation_required",
    "superseded",
    "expired",
    "invalidated"
  ]);

  const RECEIPT_STATUSES = new Set([
    "executing",
    "executed",
    "completed_pending_verification",
    "partial_failure",
    "blocked_duplicate",
    "failed",
    "reconciliation_required"
  ]);

  const ATTENTION_LABELS = Object.freeze({
    missing_adjuster: "Adjuster missing",
    missing_claim_number: "Claim number missing",
    missing_date_of_loss: "Date of loss missing",
    missing_policy_number: "Policy number missing"
  });

  const LANE_LABELS = Object.freeze({
    awaiting_response: "Waiting for a response",
    document_review_required: "Document needs review",
    missing_adjuster: "Adjuster information is missing",
    missing_claim_number: "Claim number is missing",
    missing_date_of_loss: "Date of loss is missing",
    missing_policy_number: "Policy number is missing",
    overdue_task: "Task is overdue",
    reply_required: "Reply needed",
    source_partial: "Source evidence is partial",
    source_stale: "Source evidence is stale",
    source_unavailable: "Source is unavailable",
    task_due_today: "Task is due today"
  });

  const CONNECTOR_LABELS = Object.freeze({
    carrierFollowUp: "Carrier follow-up",
    claimFiling: "Claim filing",
    clientCoordinator: "Client coordinator",
    gmail: "Gmail",
    googleCalendar: "Google Calendar",
    googleOAuth: "Google sign-in",
    jobNimbus: "JobNimbus",
    quo: "Quo",
    realtimeVoice: "Realtime voice"
  });

  const GATE_LABELS = Object.freeze({
    carrierFollowUpCalls: "Carrier follow-up calls",
    claimFilingCalls: "Claim filing calls",
    clientCoordinatorAppointmentCalls: "Appointment calls",
    clientCoordinatorExpandedCalls: "Expanded coordinator calls",
    externalWrites: "External writes",
    hcnActionExecution: "HCN action execution",
    gmailSend: "Gmail sending",
    quoSend: "Quo sending",
    realtimeVoiceCalls: "Realtime voice calls"
  });

  const BOUNDARY_LABELS = Object.freeze({
    chanceBrain: {
      title: "Chance Brain",
      states: {
        legacy_read_only_non_operator_paths: "Legacy compatibility · read only"
      }
    },
    hcnV2ChanceBrainDataFlow: {
      title: "HCN v2 → Chance Brain",
      states: {
        disconnected: "Disconnected · no data flow"
      }
    },
    jobrolo: {
      title: "Jobrolo",
      states: {
        disconnected: "Disconnected · separate product"
      }
    },
    hcnOperationsBrain: {
      title: "HCN Operations Brain",
      states: {
        v2_foundation: "V2 foundation · HCN only"
      }
    },
    legacyClientMemory: {
      title: "Legacy client memory",
      states: {
        migration_required: "Restricted · migration required"
      }
    }
  });

  const CAPABILITY_GROUP_LABELS = Object.freeze({
    brain: "Advisory",
    claims: "Claims",
    gmail: "Gmail",
    handoff: "Handoffs",
    hcn: "HCN console",
    identity: "Identity",
    jobnimbus: "JobNimbus",
    memory: "Memory controls",
    operations: "Operations",
    platform: "Platform",
    quo: "Quo",
    retell: "Call workflows",
    scheduling: "Scheduling",
    voice: "Voice",
    weather: "Weather"
  });

  const state = {
    loading: false,
    meta: null,
    session: null,
    metaError: null,
    sessionError: null,
    workCenter: null,
    selectedFileRef: null,
    fileReview: null,
    workCenterLoading: false,
    fileLoading: false,
    workCenterController: null,
    fileController: null,
    actionController: null,
    receiptController: null,
    actionDraft: [],
    actionPlans: null,
    selectedPlanId: null,
    actionPlan: null,
    actionLoading: false,
    receipts: null,
    selectedReceiptPlanId: null,
    receipt: null,
    receiptLoading: false,
    sessionDeadlineMs: 0,
    sessionExpiryTimer: null
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", initialize);

  function initialize() {
    [
      "connection-status",
      "connection-status-text",
      "sign-in-action",
      "sign-out-action",
      "retry-action",
      "readiness-summary",
      "load-message",
      "readiness-score",
      "readiness-label",
      "connector-metric",
      "connector-metric-detail",
      "gate-metric",
      "gate-metric-detail",
      "capability-metric",
      "capability-metric-detail",
      "build-metric",
      "build-metric-detail",
      "connectors-card-status",
      "controls-card-status",
      "connector-list",
      "gate-list",
      "drift-message",
      "boundary-list",
      "build-card-status",
      "build-details",
      "identity-badge",
      "capability-summary",
      "capability-groups",
      "freshness-text",
      "work-center-summary",
      "work-center-status",
      "work-center-refresh",
      "work-center-alert",
      "work-center-locked",
      "work-center-workspace",
      "work-center-count",
      "work-center-freshness",
      "work-center-list",
      "file-placeholder",
      "file-review",
      "file-back",
      "file-job-number",
      "file-name",
      "file-stage",
      "file-evidence-status",
      "file-refresh",
      "file-alert",
      "file-freshness",
      "source-health",
      "key-facts",
      "priority-count",
      "priority-lane",
      "today-count",
      "today-lane",
      "waiting-count",
      "waiting-lane",
      "recent-tasks",
      "recent-documents",
      "recent-gmail",
      "recent-quo",
      "recent-activities",
      "action-composer",
      "action-composer-count",
      "action-composer-alert",
      "action-form",
      "action-type",
      "action-note",
      "create-task-title",
      "create-task-description",
      "create-task-due-date",
      "update-task-ref",
      "update-task-title",
      "update-task-description",
      "update-task-due-date",
      "update-task-completed",
      "action-status",
      "action-date-of-loss",
      "action-add",
      "action-draft-clear",
      "action-draft-list",
      "action-prepare",
      "approval-status",
      "approval-refresh",
      "approval-alert",
      "approval-locked",
      "approval-workspace",
      "approval-count",
      "approval-list",
      "approval-placeholder",
      "approval-detail",
      "approval-plan-title",
      "approval-plan-state",
      "approval-plan-id",
      "approval-file-ref",
      "approval-expires-at",
      "approval-digest",
      "approval-operations",
      "execution-gate-message",
      "approval-acknowledge",
      "approval-invalidate",
      "approval-execute",
      "receipt-status",
      "receipt-refresh",
      "receipt-alert",
      "receipt-locked",
      "receipt-workspace",
      "receipt-count",
      "receipt-list",
      "receipt-placeholder",
      "receipt-detail",
      "receipt-detail-heading",
      "receipt-detail-state",
      "receipt-detail-fields"
    ].forEach(function (id) {
      elements[id] = document.getElementById(id);
    });

    elements["retry-action"].addEventListener("click", loadPlatformState);
    elements["sign-out-action"].addEventListener("click", signOut);
    elements["work-center-refresh"].addEventListener("click", function () {
      loadWorkCenter({ resetFile: true });
    });
    elements["file-refresh"].addEventListener("click", function () {
      if (state.selectedFileRef) loadFileReview(state.selectedFileRef);
    });
    elements["file-back"].addEventListener("click", closeFileReview);
    elements["action-type"].addEventListener("change", renderActionFields);
    elements["action-form"].addEventListener("submit", addDraftAction);
    elements["action-draft-clear"].addEventListener("click", function () {
      clearActionDraft("The memory-only draft was cleared.");
    });
    elements["action-prepare"].addEventListener("click", prepareActionPlan);
    elements["approval-refresh"].addEventListener("click", function () {
      loadActionPlans();
    });
    elements["approval-acknowledge"].addEventListener(
      "change",
      syncExecutionControls
    );
    elements["approval-invalidate"].addEventListener(
      "click",
      invalidateSelectedPlan
    );
    elements["approval-execute"].addEventListener(
      "click",
      executeSelectedPlan
    );
    elements["receipt-refresh"].addEventListener("click", function () {
      loadReceipts();
    });
    window.addEventListener("online", handleNetworkChange);
    window.addEventListener("offline", handleNetworkChange);
    document.addEventListener("visibilitychange", enforceSessionDeadline);

    loadPlatformState();
    registerServiceWorker();
  }

  async function loadPlatformState() {
    if (state.loading) return;
    cancelSessionExpiryTimer();
    state.loading = true;
    state.metaError = null;
    state.sessionError = null;
    clearOperationalData("Rechecking the signed-in session before loading client records.");
    setLoadingView();

    const results = await Promise.allSettled([
      fetchJson(ENDPOINTS.meta),
      fetchJson(ENDPOINTS.session)
    ]);

    if (results[0].status === "fulfilled") {
      state.meta = results[0].value;
      renderMeta(state.meta);
    } else {
      state.meta = null;
      state.metaError = results[0].reason;
      renderMetaError(state.metaError);
    }

    if (results[1].status === "fulfilled") {
      state.session = results[1].value;
      renderSession(state.session);
    } else {
      state.session = null;
      state.sessionError = results[1].reason;
      renderSessionError(state.sessionError);
    }

    state.loading = false;
    elements["retry-action"].disabled = false;
    renderOverallState();
    syncOperationalAccess();
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const error = new Error("Request failed");
      error.status = response.status;
      throw error;
    }
    if (url === ENDPOINTS.session) {
      applySessionDeadlinesFromResponse(response);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Unexpected response format");
    }

    const data = await response.json();
    if (!isRecord(data)) throw new Error("Invalid response");
    return data;
  }

  async function postOperationalJson(url, body, signal, requiredCapability) {
    if (
      !hasChanceBrowserAuthority()
      || (
        requiredCapability
        && !sessionCapabilities().includes(requiredCapability)
      )
    ) {
      const error = new Error("Operational authority is unavailable");
      error.status = 403;
      throw error;
    }

    const csrfToken = stringValue(
      record(record(state.session).browserSession).csrfToken
    );
    if (!csrfToken) {
      const error = new Error("Session verification is unavailable");
      error.status = 401;
      throw error;
    }

    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-HCN-CSRF": csrfToken
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = new Error("Operational request failed");
      error.status = response.status;
      throw error;
    }
    applySessionDeadlinesFromResponse(response);

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error("Unexpected response format");
    }

    const data = await response.json();
    if (!isRecord(data)) throw new Error("Invalid response");
    return data;
  }

  function applySessionDeadlinesFromResponse(response) {
    const idleExpiresAt = response.headers.get(SESSION_IDLE_HEADER);
    const expiresAt = response.headers.get(SESSION_ABSOLUTE_HEADER);
    if (!scheduleSessionExpiry(idleExpiresAt, expiresAt)) {
      expireBrowserSession(
        "The HCN session expiry could not be verified. Client data was cleared."
      );
      const error = new Error("Session expiry verification failed");
      error.status = 401;
      throw error;
    }
    const session = record(state.session);
    const browserSession = record(session.browserSession);
    if (session.authenticated === true && stringValue(browserSession.csrfToken)) {
      state.session = {
        ...session,
        browserSession: {
          ...browserSession,
          idleExpiresAt: idleExpiresAt,
          expiresAt: expiresAt
        }
      };
    }
  }

  function scheduleSessionExpiry(idleExpiresAt, expiresAt) {
    const idleDeadline = Date.parse(String(idleExpiresAt || ""));
    const absoluteDeadline = Date.parse(String(expiresAt || ""));
    if (
      !Number.isFinite(idleDeadline)
      || !Number.isFinite(absoluteDeadline)
      || idleDeadline <= 0
      || absoluteDeadline <= 0
    ) {
      cancelSessionExpiryTimer();
      return false;
    }
    const deadline = Math.min(idleDeadline, absoluteDeadline);
    cancelSessionExpiryTimer();
    state.sessionDeadlineMs = deadline;
    if (deadline <= Date.now()) return false;
    state.sessionExpiryTimer = window.setTimeout(
      function () {
        expireBrowserSession(
          "The HCN session expired. Client data was cleared from this page."
        );
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(1, deadline - Date.now()))
    );
    return true;
  }

  function scheduleSessionExpiryFromSession(session) {
    const browserSession = record(record(session).browserSession);
    return scheduleSessionExpiry(
      browserSession.idleExpiresAt,
      browserSession.expiresAt
    );
  }

  function cancelSessionExpiryTimer() {
    if (state.sessionExpiryTimer !== null) {
      window.clearTimeout(state.sessionExpiryTimer);
    }
    state.sessionExpiryTimer = null;
    state.sessionDeadlineMs = 0;
  }

  function enforceSessionDeadline() {
    if (document.hidden || !state.sessionDeadlineMs) return;
    if (Date.now() < state.sessionDeadlineMs) return;
    expireBrowserSession(
      "The HCN session expired. Client data was cleared from this page."
    );
  }

  function expireBrowserSession(message) {
    cancelSessionExpiryTimer();
    clearOperationalData(message);
    state.session = null;
    state.sessionError = { status: 401 };
    renderSignedOut(
      "Sign in with your HCN account to verify operating authority again."
    );
    renderOperationsLocked(
      "Session expired",
      "Sign in with the authorized Chance account to load fresh assigned files."
    );
    renderOverallState();
  }

  function setLoadingView() {
    elements["retry-action"].disabled = true;
    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = true;
    setConnection("pending", "Checking");
    setText(elements["load-message"], "Checking fresh platform and session metadata…");
  }

  function renderMeta(meta) {
    const runtime = record(meta.runtime);
    renderConnectors(record(runtime.connectors));
    renderGates(record(runtime.gates), record(runtime.configurationDrift));
    renderBoundaries(record(meta.boundaries));
    renderBuild(record(meta.build));

    const generatedAt = readableTime(meta.generatedAt);
    setText(
      elements["freshness-text"],
      generatedAt
        ? "Platform metadata checked " + generatedAt + "."
        : "Platform metadata received; timestamp unavailable."
    );
    syncExecutionControls();
  }

  function renderMetaError(error) {
    setText(elements["connector-metric"], "Unavailable");
    setText(elements["connector-metric-detail"], "Bridge metadata not received");
    setText(elements["gate-metric"], "Unavailable");
    setText(elements["gate-metric-detail"], "Runtime gates not received");
    setText(elements["build-metric"], "Unverified");
    setText(elements["build-metric-detail"], "Build metadata not received");
    badge(elements["connectors-card-status"], "Unavailable", "bad");
    badge(elements["controls-card-status"], "Unavailable", "bad");
    badge(elements["build-card-status"], "Unverified", "bad");
    renderEmpty(elements["connector-list"], "Connected-system status is unavailable.");
    renderEmpty(elements["gate-list"], "Runtime gate status is unavailable.");
    renderEmpty(elements["boundary-list"], "System boundaries could not be verified.");
    renderBuildPlaceholder("Metadata unavailable");
    setText(
      elements["freshness-text"],
      statusOf(error) ? "Platform check returned status " + statusOf(error) + "." : "Platform check failed."
    );
    syncExecutionControls();
  }

  function renderConnectors(connectors) {
    const entries = knownEntries(connectors, CONNECTOR_LABELS);
    const configured = entries.filter(function (entry) {
      return entry.value === "configured";
    }).length;

    setText(elements["connector-metric"], configured + " / " + entries.length);
    setText(elements["connector-metric-detail"], "Configured now");
    badge(
      elements["connectors-card-status"],
      configured === entries.length ? "All configured" : configured + " configured",
      configured === entries.length ? "good" : "neutral"
    );
    renderStatusItems(elements["connector-list"], entries, connectorTone);
  }

  function renderGates(gates, drift) {
    const entries = knownEntries(gates, GATE_LABELS);
    const enabled = entries.filter(function (entry) {
      return entry.value === "enabled";
    }).length;

    setText(elements["gate-metric"], enabled + " enabled");
    setText(elements["gate-metric-detail"], entries.length + " effect gates reported");
    badge(elements["controls-card-status"], entries.length + " reported", "neutral");
    renderStatusItems(elements["gate-list"], entries, gateTone);

    const driftStatus = stringValue(drift.status);
    if (driftStatus === "aligned") {
      notice(
        elements["drift-message"],
        "Release-critical effect gates match the checked-in defaults.",
        "good"
      );
    } else if (driftStatus === "detected") {
      const differences = Array.isArray(drift.differences) ? drift.differences.length : 0;
      notice(
        elements["drift-message"],
        "Runtime configuration drift detected across " + differences + " release-critical gate" +
          (differences === 1 ? "." : "s."),
        "warn"
      );
    } else {
      notice(
        elements["drift-message"],
        "Some release-critical gate values could not be compared.",
        "neutral"
      );
    }
  }

  function renderBoundaries(boundaries) {
    const fragment = document.createDocumentFragment();

    Object.keys(BOUNDARY_LABELS).forEach(function (key) {
      const specification = BOUNDARY_LABELS[key];
      const value = stringValue(boundaries[key]) || "unknown";
      const item = document.createElement("div");
      item.className = "boundary-item";

      const copy = document.createElement("div");
      const title = document.createElement("strong");
      const status = document.createElement("span");
      const mark = document.createElement("i");

      setText(title, specification.title);
      setText(status, specification.states[value] || humanize(value));
      mark.className = "boundary-state";
      mark.setAttribute("aria-hidden", "true");
      if (value === "migration_required" || value === "unknown") {
        mark.dataset.tone = "warn";
      }

      copy.append(title, status);
      item.append(copy, mark);
      fragment.append(item);
    });

    elements["boundary-list"].replaceChildren(fragment);
  }

  function renderBuild(build) {
    const attested = build.attested === true;
    const sourceCommit = stringValue(build.sourceCommit);
    const runtime = record(build.runtime);
    const runtimeText = [
      stringValue(runtime.name),
      stringValue(runtime.version),
      stringValue(runtime.platform),
      stringValue(runtime.architecture)
    ].filter(Boolean).join(" · ");

    setText(elements["build-metric"], attested ? "Attested" : "Unverified");
    setText(
      elements["build-metric-detail"],
      sourceCommit ? "Commit " + sourceCommit.slice(0, 12) : "No source revision"
    );
    badge(elements["build-card-status"], attested ? "Provider attested" : "Not attested", attested ? "good" : "bad");

    const rows = [
      ["Service", stringValue(build.service) || "Unknown"],
      ["Source", sourceCommit ? sourceCommit.slice(0, 12) : "Unavailable"],
      ["Runtime", runtimeText || "Unknown"],
      ["API", stringValue(build.apiVersion) || "Unknown"]
    ];
    renderDetails(rows);
  }

  function renderBuildPlaceholder(message) {
    renderDetails([
      ["Service", message],
      ["Source", "Unavailable"],
      ["Runtime", "Unavailable"]
    ]);
  }

  function renderDetails(rows) {
    const fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      setText(term, row[0]);
      setText(detail, row[1]);
      wrapper.append(term, detail);
      fragment.append(wrapper);
    });
    elements["build-details"].replaceChildren(fragment);
  }

  function renderSession(session) {
    const identity = record(session.identity);
    const capabilities = Array.isArray(session.authorizedCapabilities)
      ? session.authorizedCapabilities.filter(function (value) {
          return typeof value === "string" && value.length <= 160;
        })
      : [];
    const authenticated = session.authenticated === true &&
      identity.authentication === "authenticated";

    if (!authenticated) {
      renderSignedOut("The session did not provide an authenticated operating identity.");
      return;
    }
    if (!scheduleSessionExpiryFromSession(session)) {
      expireBrowserSession(
        "The HCN session expiry could not be verified. Client data was cleared."
      );
      return;
    }

    const identityType = stringValue(identity.type);
    const role = stringValue(identity.role) || "authorized operator";
    const scope = stringValue(identity.jobNimbusScope) || "defined";
    const identityLabel = identityType === "hcn_browser_session"
      ? "HCN browser session"
      : identityType === "google_oauth"
        ? "Google session"
        : "HP operator";

    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = false;
    badge(elements["identity-badge"], identityLabel, "good");
    setText(elements["capability-metric"], String(capabilities.length));
    setText(
      elements["capability-metric-detail"],
      scope === "none"
        ? humanize(role) + " · foundation only"
        : humanize(role) + " · " + humanize(scope) + " scope"
    );
    setText(
      elements["capability-summary"],
      "Signed in as " + humanize(role) + (
        scope === "none"
          ? " for the foundation console. "
          : " with " + humanize(scope) + " JobNimbus scope. "
      ) + capabilities.length +
        " route-level capabilit" + (capabilities.length === 1 ? "y is" : "ies are") +
        " authorized; runtime gates still control effects."
    );
    renderCapabilityGroups(capabilities);
  }

  function renderSessionError(error) {
    const status = statusOf(error);
    if (status === 401 || status === 403) {
      renderSignedOut("Sign in with your HCN account to see your exact operating scope.");
      return;
    }

    elements["sign-in-action"].hidden = true;
    elements["sign-out-action"].hidden = true;
    badge(elements["identity-badge"], "Unavailable", "bad");
    setText(elements["capability-metric"], "Unavailable");
    setText(elements["capability-metric-detail"], "Session check failed");
    setText(
      elements["capability-summary"],
      "Your operating scope could not be checked. No authority is assumed."
    );
    elements["capability-groups"].replaceChildren();
  }

  function renderSignedOut(message) {
    cancelSessionExpiryTimer();
    elements["sign-in-action"].hidden = false;
    elements["sign-out-action"].hidden = true;
    badge(elements["identity-badge"], "Sign in required", "neutral");
    setText(elements["capability-metric"], "Sign in");
    setText(elements["capability-metric-detail"], "Authority not assumed");
    setText(elements["capability-summary"], message);
    elements["capability-groups"].replaceChildren();
  }

  async function signOut() {
    const browserSession = record(record(state.session).browserSession);
    const csrfToken = stringValue(browserSession.csrfToken);
    if (!csrfToken) {
      clearOperationalData("The browser session could not be verified.");
      await loadPlatformState();
      return;
    }

    cancelSessionExpiryTimer();
    clearOperationalData("Signing out and clearing client records from this page.");
    elements["sign-out-action"].disabled = true;
    try {
      const response = await fetch(ENDPOINTS.logout, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-HCN-CSRF": csrfToken
        },
        body: "{}"
      });
      if (!response.ok) throw new Error("Sign out failed");
      state.session = null;
      state.sessionError = { status: 401 };
      renderSignedOut("You are signed out. No operating authority is assumed.");
      renderOperationsLocked(
        "Signed out",
        "Sign in with the authorized Chance account to load fresh assigned files."
      );
      renderOverallState();
    } catch {
      setText(
        elements["load-message"],
        "Sign out could not be confirmed. Check the session again before continuing."
      );
    } finally {
      elements["sign-out-action"].disabled = false;
    }
  }

  function sessionCapabilities() {
    const values = record(state.session).authorizedCapabilities;
    return Array.isArray(values)
      ? values.filter(function (value) {
          return typeof value === "string" && value.length <= 160;
        })
      : [];
  }

  function hasChanceBrowserAuthority() {
    if (
      state.sessionDeadlineMs
      && Date.now() >= state.sessionDeadlineMs
    ) {
      expireBrowserSession(
        "The HCN session expired. Client data was cleared from this page."
      );
      return false;
    }
    const session = record(state.session);
    const identity = record(session.identity);
    return (
      session.authenticated === true &&
      identity.authentication === "authenticated" &&
      identity.type === "hcn_browser_session" &&
      identity.role === "chance"
    );
  }

  function hasWorkCenterAuthority() {
    return (
      hasChanceBrowserAuthority()
      && sessionCapabilities().includes(WORK_CENTER_CAPABILITY)
    );
  }

  function hasFileReviewAuthority() {
    return (
      hasWorkCenterAuthority() &&
      sessionCapabilities().includes(FILE_REVIEW_CAPABILITY)
    );
  }

  function hasActionReadAuthority() {
    return (
      hasChanceBrowserAuthority()
      && sessionCapabilities().includes(ACTION_READ_CAPABILITY)
    );
  }

  function hasActionPrepareAuthority() {
    return (
      hasFileReviewAuthority()
      && hasActionReadAuthority()
      && sessionCapabilities().includes(ACTION_PREPARE_CAPABILITY)
    );
  }

  function hasActionInvalidateAuthority() {
    return (
      hasActionReadAuthority()
      && sessionCapabilities().includes(ACTION_INVALIDATE_CAPABILITY)
    );
  }

  function hasReceiptReadAuthority() {
    return (
      hasChanceBrowserAuthority()
      && sessionCapabilities().includes(RECEIPT_READ_CAPABILITY)
    );
  }

  function syncOperationalAccess() {
    syncActionAccess();
    if (!navigator.onLine) {
      clearOperationalData("Reconnect to request fresh client evidence.");
      renderOperationsLocked(
        "Offline",
        "Client data was cleared from this page. Reconnect to run a fresh read."
      );
      return;
    }

    if (!hasWorkCenterAuthority()) {
      const session = record(state.session);
      const identity = record(session.identity);
      const authenticated = session.authenticated === true &&
        identity.authentication === "authenticated";
      renderOperationsLocked(
        authenticated ? "Not authorized" : "Sign in required",
        authenticated
          ? "This HCN session does not have Chance’s Work Center read capability."
          : "Sign in with the authorized Chance account to load fresh assigned files."
      );
      return;
    }

    elements["work-center-locked"].hidden = true;
    elements["work-center-workspace"].hidden = false;
    elements["work-center-refresh"].hidden = false;
    badge(elements["work-center-status"], "Read only", "good");
    setText(
      elements["work-center-summary"],
      "Fresh assigned-file evidence is available for this verified Chance session."
    );
    if (!state.workCenter && !state.workCenterLoading) {
      loadWorkCenter({ resetFile: true });
    }
  }

  function renderOperationsLocked(status, message) {
    elements["work-center-locked"].hidden = false;
    elements["work-center-workspace"].hidden = true;
    elements["work-center-refresh"].hidden = true;
    badge(elements["work-center-status"], status, "neutral");
    setText(elements["work-center-summary"], message);
    notice(
      elements["work-center-alert"],
      "Client records are not loaded in this view.",
      "neutral"
    );
  }

  function clearOperationalData(message) {
    if (state.workCenterController) state.workCenterController.abort();
    if (state.fileController) state.fileController.abort();
    if (state.actionController) state.actionController.abort();
    if (state.receiptController) state.receiptController.abort();
    state.workCenterController = null;
    state.fileController = null;
    state.actionController = null;
    state.receiptController = null;
    state.workCenterLoading = false;
    state.fileLoading = false;
    state.workCenter = null;
    state.selectedFileRef = null;
    state.fileReview = null;

    elements["work-center-list"].setAttribute("aria-busy", "false");
    elements["work-center-refresh"].disabled = false;
    elements["file-refresh"].disabled = false;
    setText(elements["work-center-count"], "—");
    setText(elements["work-center-freshness"], "No client records are retained on this page.");
    renderWorkspaceEmpty(elements["work-center-list"], message || "Fresh data is not loaded.");
    closeFileReview();
    clearActionControlData(
      message || "Action plans and receipt metadata are not retained on this page."
    );
  }

  async function loadWorkCenter(options) {
    const resetFile = !options || options.resetFile !== false;
    if (!hasWorkCenterAuthority()) {
      syncOperationalAccess();
      return;
    }
    if (!navigator.onLine) {
      clearOperationalData("Reconnect to request a fresh Work Center.");
      syncOperationalAccess();
      return;
    }

    if (state.workCenterController) state.workCenterController.abort();
    const controller = new AbortController();
    state.workCenterController = controller;
    state.workCenterLoading = true;
    state.workCenter = null;
    if (resetFile) {
      state.selectedFileRef = null;
      state.fileReview = null;
      closeFileReview();
    }

    elements["work-center-list"].setAttribute("aria-busy", "true");
    elements["work-center-refresh"].disabled = true;
    badge(elements["work-center-status"], "Loading", "neutral");
    notice(
      elements["work-center-alert"],
      "Checking the current Chance-assigned JobNimbus queue.",
      "neutral"
    );
    renderWorkspaceEmpty(elements["work-center-list"], "Loading fresh assigned files…");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.workCenter,
        { offset: 0, limit: 25 },
        controller.signal
      );
      if (controller.signal.aborted) return;
      state.workCenter = normalizeWorkCenterResponse(response);
      renderWorkCenter(state.workCenter);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.workCenter = null;
      badge(elements["work-center-status"], "Unavailable", "bad");
      notice(
        elements["work-center-alert"],
        workCenterErrorMessage(error),
        "bad"
      );
      renderWorkspaceEmpty(
        elements["work-center-list"],
        "The fresh assigned-file queue could not be loaded."
      );
      setText(elements["work-center-count"], "—");
      setText(elements["work-center-freshness"], "No stale queue is shown.");
    } finally {
      if (state.workCenterController === controller) {
        state.workCenterController = null;
        state.workCenterLoading = false;
        elements["work-center-list"].setAttribute("aria-busy", "false");
        elements["work-center-refresh"].disabled = false;
      }
    }
  }

  function normalizeWorkCenterResponse(value) {
    if (
      value.schema !== "hcn.console.work-center.v1" ||
      value.ephemeral !== true ||
      value.cachePolicy !== "no_store" ||
      !Array.isArray(value.files)
    ) {
      throw new Error("Invalid Work Center response");
    }

    const page = record(value.page);
    if (
      !Number.isInteger(page.offset) ||
      !Number.isInteger(page.limit) ||
      !Number.isInteger(page.total) ||
      page.offset !== 0 ||
      page.limit !== 25 ||
      page.total < 0
    ) {
      throw new Error("Invalid Work Center page");
    }

    const files = value.files.map(function (candidate) {
      const file = record(candidate);
      const fileRef = boundedString(file.fileRef, 80);
      if (!FILE_REF.test(fileRef)) throw new Error("Invalid file reference");
      const attentionCodes = Array.isArray(file.attentionCodes)
        ? file.attentionCodes.slice(0, 8).map(function (code) {
            return boundedString(code, 64);
          }).filter(Boolean)
        : [];
      const missing = record(file.missing);
      return {
        fileRef: fileRef,
        jobNumber: boundedString(file.jobNumber, 64),
        displayName: boundedString(file.displayName, 80),
        statusCode: boundedString(file.statusCode, 64),
        stageCode: boundedString(file.stageCode, 64),
        fileTypeCode: boundedString(file.fileTypeCode, 64),
        updatedAt: boundedString(file.updatedAt, 40),
        lane: boundedString(file.lane, 32),
        attentionCodes: attentionCodes,
        missing: {
          claimNumber: missing.claimNumber === true,
          policyNumber: missing.policyNumber === true,
          dateOfLoss: missing.dateOfLoss === true,
          adjuster: missing.adjuster === true
        }
      };
    });

    return {
      generatedAt: boundedString(value.generatedAt, 40),
      source: normalizeSourceSummary(value.source, "jobnimbus"),
      page: {
        offset: page.offset,
        limit: page.limit,
        total: page.total,
        hasMore: page.hasMore === true
      },
      files: files
    };
  }

  function renderWorkCenter(workCenter) {
    const files = workCenter.files;
    const total = workCenter.page.total;
    setText(
      elements["work-center-count"],
      total > files.length ? files.length + " / " + total : String(total)
    );
    setText(
      elements["work-center-freshness"],
      "Fresh JobNimbus check " + readableDateTime(workCenter.generatedAt) +
        (workCenter.page.hasMore ? " · showing the first 25 files." : ".")
    );
    badge(elements["work-center-status"], "Fresh · read only", "good");
    notice(
      elements["work-center-alert"],
      files.length
        ? files.length + " active assigned file" + (files.length === 1 ? " is" : "s are") +
          " ready for exact review."
        : "The fresh assigned-file queue is empty.",
      "good"
    );

    if (!files.length) {
      renderWorkspaceEmpty(
        elements["work-center-list"],
        "No active insurance files are currently assigned to Chance."
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    files.forEach(function (file) {
      fragment.append(createWorkFileButton(file));
    });
    elements["work-center-list"].replaceChildren(fragment);
  }

  function createWorkFileButton(file) {
    const button = document.createElement("button");
    const top = document.createElement("span");
    const name = document.createElement("span");
    const number = document.createElement("span");
    const meta = document.createElement("span");
    const status = document.createElement("span");
    const stage = document.createElement("span");
    const badges = document.createElement("span");

    button.type = "button";
    button.className = "work-file";
    button.setAttribute("aria-pressed", file.fileRef === state.selectedFileRef ? "true" : "false");
    if (file.fileRef === state.selectedFileRef) button.classList.add("is-selected");
    top.className = "work-file-top";
    name.className = "work-file-name";
    number.className = "work-file-number";
    meta.className = "work-file-meta";
    badges.className = "work-file-badges";

    setText(name, file.displayName || "Unnamed assigned file");
    setText(number, file.jobNumber || "No job number");
    setText(status, humanize(file.statusCode || "status unavailable"));
    setText(stage, humanize(file.stageCode || "stage unavailable"));
    top.append(name, number);
    meta.append(status, stage);

    if (file.attentionCodes.length) {
      file.attentionCodes.forEach(function (code) {
        const item = document.createElement("span");
        item.className = "attention-badge";
        setText(item, ATTENTION_LABELS[code] || humanize(code));
        badges.append(item);
      });
    } else {
      const active = document.createElement("span");
      active.className = "attention-badge";
      active.dataset.tone = "active";
      setText(active, "Active");
      badges.append(active);
    }

    button.append(top, meta, badges);
    button.addEventListener("click", function () {
      loadFileReview(file.fileRef);
    });
    return button;
  }

  async function loadFileReview(fileRef) {
    if (!hasFileReviewAuthority() || !FILE_REF.test(String(fileRef || ""))) {
      notice(
        elements["work-center-alert"],
        "This session cannot open exact file evidence.",
        "bad"
      );
      return;
    }
    const selected = record(state.workCenter).files?.find(function (file) {
      return file.fileRef === fileRef;
    });
    if (!selected) {
      notice(
        elements["work-center-alert"],
        "Refresh the queue before opening that file.",
        "warn"
      );
      return;
    }
    if (!navigator.onLine) {
      clearOperationalData("Client data was cleared when the connection went offline.");
      syncOperationalAccess();
      return;
    }

    if (state.fileController) state.fileController.abort();
    const controller = new AbortController();
    state.fileController = controller;
    state.fileLoading = true;
    state.selectedFileRef = fileRef;
    state.fileReview = null;
    renderWorkCenter(state.workCenter);
    openFileLoading(selected);

    try {
      const response = await postOperationalJson(
        ENDPOINTS.fileReview,
        { fileRef: fileRef, recentLimit: 20 },
        controller.signal
      );
      if (controller.signal.aborted) return;
      state.fileReview = normalizeFileResponse(response, fileRef);
      renderFileReview(state.fileReview);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.fileReview = null;
      badge(elements["file-evidence-status"], "Unavailable", "bad");
      notice(
        elements["file-alert"],
        fileErrorMessage(error),
        "bad"
      );
      resetFileEvidenceContainers(
        "Fresh file evidence could not be loaded. No earlier file detail is shown."
      );
    } finally {
      if (state.fileController === controller) {
        state.fileController = null;
        state.fileLoading = false;
        elements["file-refresh"].disabled = false;
      }
    }
  }

  function openFileLoading(selected) {
    resetActionComposerForFile(
      "Waiting for fresh file evidence before actions can be prepared."
    );
    elements["work-center-workspace"].dataset.fileOpen = "true";
    elements["file-placeholder"].hidden = true;
    elements["file-review"].hidden = false;
    elements["file-refresh"].disabled = true;
    setText(elements["file-job-number"], selected.jobNumber || "Exact file");
    setText(elements["file-name"], selected.displayName || "Assigned file");
    setText(
      elements["file-stage"],
      humanize(selected.statusCode || "status unavailable") + " · " +
        humanize(selected.stageCode || "stage unavailable")
    );
    badge(elements["file-evidence-status"], "Checking", "neutral");
    notice(
      elements["file-alert"],
      "Loading fresh JobNimbus, Gmail, and Quo evidence for this exact file.",
      "neutral"
    );
    setText(elements["file-freshness"], "Checking now");
    resetFileEvidenceContainers("Loading fresh evidence…");
    if (window.matchMedia("(max-width: 620px)").matches) {
      elements["file-review"].scrollIntoView({ block: "start" });
    }
  }

  function closeFileReview() {
    if (state.fileController) state.fileController.abort();
    state.fileController = null;
    state.fileLoading = false;
    state.selectedFileRef = null;
    state.fileReview = null;
    elements["work-center-workspace"].removeAttribute("data-file-open");
    elements["file-placeholder"].hidden = false;
    elements["file-review"].hidden = true;
    elements["file-refresh"].disabled = false;
    purgeFileReviewDom();
    resetActionComposerForFile("Choose one exact file before preparing actions.");
    if (state.workCenter) renderWorkCenter(state.workCenter);
  }

  function purgeFileReviewDom() {
    setText(elements["file-job-number"], "No file selected");
    setText(elements["file-name"], "Choose a file from the fresh queue");
    setText(elements["file-stage"], "No client data is retained");
    badge(elements["file-evidence-status"], "Not loaded", "neutral");
    notice(
      elements["file-alert"],
      "Open one exact file to request fresh evidence.",
      "neutral"
    );
    setText(elements["file-freshness"], "No evidence loaded");
    resetFileEvidenceContainers("No client data is retained.");
  }

  function normalizeFileResponse(value, expectedFileRef) {
    if (
      value.schema !== "hcn.console.file.v1" ||
      value.ephemeral !== true ||
      value.cachePolicy !== "no_store"
    ) {
      throw new Error("Invalid file response");
    }
    const sourceFile = record(value.file);
    const fileRef = boundedString(sourceFile.fileRef, 80);
    if (fileRef !== expectedFileRef || !FILE_REF.test(fileRef)) {
      throw new Error("File response did not match the selected file");
    }

    const client = record(sourceFile.client);
    const property = record(sourceFile.property);
    const insurance = record(sourceFile.insurance);
    const missing = record(sourceFile.missing);
    const sources = record(value.sources);
    const lanes = record(value.lanes);
    const recent = record(value.recent);

    return {
      generatedAt: boundedString(value.generatedAt, 40),
      evidenceStatus: boundedString(value.evidenceStatus, 32),
      file: {
        fileRef: fileRef,
        jobNumber: boundedString(sourceFile.jobNumber, 64),
        displayName: boundedString(sourceFile.displayName, 120),
        statusCode: boundedString(sourceFile.statusCode, 64),
        stageCode: boundedString(sourceFile.stageCode, 64),
        fileTypeCode: boundedString(sourceFile.fileTypeCode, 64),
        updatedAt: boundedString(sourceFile.updatedAt, 40),
        nextAppointmentAt: boundedString(sourceFile.nextAppointmentAt, 40),
        client: {
          primaryEmail: boundedString(client.primaryEmail, 254),
          primaryPhone: boundedString(client.primaryPhone, 64)
        },
        property: {
          address: boundedString(property.address, 180)
        },
        insurance: {
          carrierName: boundedString(insurance.carrierName, 120),
          claimNumber: boundedString(insurance.claimNumber, 80),
          policyNumber: boundedString(insurance.policyNumber, 80)
        },
        missing: {
          claimNumber: missing.claimNumber === true,
          policyNumber: missing.policyNumber === true,
          dateOfLoss: missing.dateOfLoss === true,
          adjuster: missing.adjuster === true
        }
      },
      sources: {
        jobnimbus: normalizeSourceSummary(sources.jobnimbus, "jobnimbus"),
        gmail: normalizeSourceSummary(sources.gmail, "gmail"),
        quo: normalizeSourceSummary(sources.quo, "quo")
      },
      lanes: {
        priority: normalizeLaneItems(lanes.priority),
        today: normalizeLaneItems(lanes.today),
        waiting: normalizeLaneItems(lanes.waiting)
      },
      recent: {
        activities: normalizeRecentItems(recent.activities, "activity"),
        tasks: normalizeRecentItems(recent.tasks, "task"),
        documents: normalizeRecentItems(recent.documents, "document"),
        gmail: normalizeRecentItems(recent.gmail, "gmail"),
        quo: normalizeRecentItems(recent.quo, "quo")
      }
    };
  }

  function normalizeSourceSummary(value, expectedSource) {
    const source = record(value);
    return {
      source: boundedString(source.source, 32) || expectedSource,
      status: boundedString(source.status, 32),
      completeness: boundedString(source.completeness, 32),
      failureCode: boundedString(source.failureCode, 64),
      checkedAt: boundedString(source.checkedAt, 40),
      validUntil: boundedString(source.validUntil, 40),
      acceptedItems: Number.isInteger(source.acceptedItems)
        ? Math.max(0, source.acceptedItems)
        : 0,
      droppedItems: Number.isInteger(source.droppedItems)
        ? Math.max(0, source.droppedItems)
        : 0
    };
  }

  function normalizeLaneItems(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map(function (candidate) {
      const item = record(candidate);
      return {
        reasonCode: boundedString(item.reasonCode, 64),
        source: boundedString(item.source, 32),
        at: boundedString(item.at, 40)
      };
    }).filter(function (item) {
      return Boolean(item.reasonCode);
    });
  }

  function normalizeRecentItems(value, kind) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map(function (candidate) {
      const item = record(candidate);
      const reference = boundedString(item.reference, 80);
      if (kind === "task" && !TASK_REF.test(reference)) {
        throw new Error("Invalid task reference");
      }
      const base = {
        category: kind,
        reference: reference,
        typeCode: boundedString(item.kind, 64),
        label: boundedString(item.label, 160),
        occurredAt: boundedString(item.occurredAt, 40),
        dueAt: boundedString(item.dueAt, 40),
        createdAt: boundedString(item.createdAt, 40),
        state: boundedString(item.state, 64),
        status: boundedString(item.status, 64),
        priority: boundedString(item.priority, 64),
        actorRole: boundedString(item.actorRole, 64),
        assignedRole: boundedString(item.assignedRole, 64),
        fileName: boundedString(item.fileName, 160),
        reviewState: boundedString(item.reviewState, 64),
        direction: boundedString(item.direction, 64),
        actionState: boundedString(item.actionState, 64),
        subject: boundedString(item.subject, 160),
        snippet: boundedString(item.snippet, 240),
        channel: boundedString(item.channel, 64),
        disposition: boundedString(item.disposition, 64),
        preview: boundedString(item.preview, 240),
        hasAttachment: item.hasAttachment === true
      };
      return base;
    });
  }

  function renderFileReview(review) {
    const file = review.file;
    setText(elements["file-job-number"], file.jobNumber || "Exact file");
    setText(elements["file-name"], file.displayName || "Assigned file");
    setText(
      elements["file-stage"],
      humanize(file.statusCode || "status unavailable") + " · " +
        humanize(file.stageCode || "stage unavailable")
    );
    const complete = review.evidenceStatus === "complete";
    badge(
      elements["file-evidence-status"],
      complete ? "Evidence complete" : "Evidence partial",
      complete ? "good" : "neutral"
    );
    notice(
      elements["file-alert"],
      complete
        ? "Fresh evidence is complete across JobNimbus, Gmail, and Quo."
        : "Fresh JobNimbus detail is available; one or more optional sources are incomplete.",
      complete ? "good" : "warn"
    );
    setText(
      elements["file-freshness"],
      review.generatedAt
        ? "Checked " + readableDateTime(review.generatedAt)
        : "Fresh check completed"
    );
    renderSourceHealth(review.sources);
    renderKeyFacts(file);
    renderLane("priority", review.lanes.priority);
    renderLane("today", review.lanes.today);
    renderLane("waiting", review.lanes.waiting);
    renderRecentList(elements["recent-tasks"], review.recent.tasks, "tasks");
    renderRecentList(elements["recent-documents"], review.recent.documents, "documents");
    renderRecentList(elements["recent-gmail"], review.recent.gmail, "gmail");
    renderRecentList(elements["recent-quo"], review.recent.quo, "quo");
    renderRecentList(
      elements["recent-activities"],
      review.recent.activities,
      "activities"
    );
    populateTaskOptions(review.recent.tasks);
    renderActionComposerState();
  }

  function renderSourceHealth(sources) {
    const fragment = document.createDocumentFragment();
    ["jobnimbus", "gmail", "quo"].forEach(function (name) {
      const source = record(sources[name]);
      const complete = source.status === "fresh" &&
        source.completeness === "complete";
      const unavailable = source.completeness === "none" ||
        source.status === "incomplete" ||
        source.status === "failed";
      const item = document.createElement("article");
      const top = document.createElement("div");
      const title = document.createElement("strong");
      const dot = document.createElement("span");
      const detail = document.createElement("p");

      item.className = "source-health-item";
      item.dataset.tone = complete ? "good" : unavailable ? "bad" : "warn";
      top.className = "source-health-top";
      dot.className = "source-health-dot";
      dot.setAttribute("aria-hidden", "true");
      setText(title, name === "jobnimbus" ? "JobNimbus" : name === "gmail" ? "Gmail" : "Quo");
      setText(
        detail,
        complete
          ? source.acceptedItems + " recent item" +
            (source.acceptedItems === 1 ? "" : "s") + " accepted"
          : humanize(source.failureCode || source.completeness || "source incomplete")
      );
      top.append(title, dot);
      item.append(top, detail);
      fragment.append(item);
    });
    elements["source-health"].replaceChildren(fragment);
  }

  function renderKeyFacts(file) {
    const groups = [
      {
        title: "File",
        rows: [
          ["Job number", file.jobNumber],
          ["Status", humanize(file.statusCode)],
          ["Stage", humanize(file.stageCode)],
          ["Type", humanize(file.fileTypeCode)],
          ["Last updated", readableDateTime(file.updatedAt)]
        ]
      },
      {
        title: "Homeowner & property",
        rows: [
          ["Email", file.client.primaryEmail],
          ["Phone", file.client.primaryPhone],
          ["Property", file.property.address],
          ["Next appointment", readableDateTime(file.nextAppointmentAt)]
        ]
      },
      {
        title: "Insurance",
        rows: [
          ["Carrier", file.insurance.carrierName],
          ["Claim number", file.insurance.claimNumber, file.missing.claimNumber],
          ["Policy number", file.insurance.policyNumber, file.missing.policyNumber],
          ["Date of loss", file.missing.dateOfLoss ? "Missing" : "On file", file.missing.dateOfLoss],
          ["Adjuster", file.missing.adjuster ? "Missing" : "On file", file.missing.adjuster]
        ]
      }
    ];

    const fragment = document.createDocumentFragment();
    groups.forEach(function (group) {
      const article = document.createElement("article");
      const heading = document.createElement("h5");
      article.className = "fact-group";
      setText(heading, group.title);
      article.append(heading);
      group.rows.forEach(function (row) {
        const wrapper = document.createElement("div");
        const label = document.createElement("span");
        const value = document.createElement("strong");
        wrapper.className = "fact-row";
        setText(label, row[0]);
        setText(value, row[1] || "Not on fresh file");
        if (row[2] === true || !row[1]) value.dataset.missing = "true";
        wrapper.append(label, value);
        article.append(wrapper);
      });
      fragment.append(article);
    });
    elements["key-facts"].replaceChildren(fragment);
  }

  function renderLane(name, items) {
    const container = elements[name + "-lane"];
    setText(elements[name + "-count"], String(items.length));
    if (!items.length) {
      renderRecentEmpty(container, "Nothing is currently in this lane.");
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      const wrapper = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("span");
      wrapper.className = "lane-item";
      setText(title, LANE_LABELS[item.reasonCode] || humanize(item.reasonCode));
      setText(
        detail,
        humanize(item.source || "source") +
          (item.at ? " · " + readableDateTime(item.at) : "")
      );
      wrapper.append(title, detail);
      fragment.append(wrapper);
    });
    container.replaceChildren(fragment);
  }

  function renderRecentList(container, items, category) {
    if (!items.length) {
      renderRecentEmpty(container, "No recent " + category + " were returned.");
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach(function (item) {
      fragment.append(createRecentItem(item));
    });
    container.replaceChildren(fragment);
  }

  function createRecentItem(item) {
    const wrapper = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    wrapper.className = "recent-item";

    let titleText = item.label || item.fileName || item.subject || item.preview;
    let details = [];
    let secondary = "";
    if (item.category === "activity") {
      titleText = titleText || humanize(item.typeCode || "activity");
      details = [item.actorRole, item.state, readableDateTime(item.occurredAt)];
    } else if (item.category === "task") {
      titleText = titleText || humanize(item.typeCode || "task");
      details = [item.priority, item.status, readableDateTime(item.dueAt)];
    } else if (item.category === "document") {
      titleText = titleText || humanize(item.typeCode || "document");
      details = [item.reviewState, readableDateTime(item.createdAt)];
    } else if (item.category === "gmail") {
      titleText = titleText || "Gmail message";
      secondary = item.snippet;
      details = [
        item.direction,
        item.actionState,
        item.hasAttachment ? "attachment" : "",
        readableDateTime(item.occurredAt)
      ];
    } else {
      titleText = titleText || humanize(item.channel || "Quo contact");
      details = [
        item.channel,
        item.direction,
        item.disposition,
        item.actionState,
        readableDateTime(item.occurredAt)
      ];
    }

    setText(title, titleText);
    setText(
      detail,
      [secondary].concat(details.map(function (value) {
        return value ? humanize(value) : "";
      })).filter(Boolean).join(" · ")
    );
    wrapper.append(title, detail);
    return wrapper;
  }

  function resetFileEvidenceContainers(message) {
    renderRecentEmpty(elements["source-health"], message);
    renderRecentEmpty(elements["key-facts"], message);
    ["priority", "today", "waiting"].forEach(function (name) {
      setText(elements[name + "-count"], "0");
      renderRecentEmpty(elements[name + "-lane"], message);
    });
    [
      "recent-tasks",
      "recent-documents",
      "recent-gmail",
      "recent-quo",
      "recent-activities"
    ].forEach(function (id) {
      renderRecentEmpty(elements[id], message);
    });
  }

  function renderWorkspaceEmpty(container, message) {
    const paragraph = document.createElement("p");
    paragraph.className = "workspace-empty";
    setText(paragraph, message);
    container.replaceChildren(paragraph);
  }

  function renderRecentEmpty(container, message) {
    const paragraph = document.createElement("p");
    paragraph.className = "recent-empty";
    setText(paragraph, message);
    container.replaceChildren(paragraph);
  }

  function syncActionAccess() {
    if (!navigator.onLine || !hasChanceBrowserAuthority()) {
      clearActionControlData(
        navigator.onLine
          ? "Action and receipt data was cleared because authority is unavailable."
          : "Action and receipt data was cleared when the connection went offline."
      );
      renderApprovalLocked(
        navigator.onLine ? "Sign in required" : "Offline",
        "Fresh authority is required before action plans can be reviewed."
      );
      renderReceiptLocked(
        navigator.onLine ? "Sign in required" : "Offline",
        "Fresh authority is required before receipt metadata can be reviewed."
      );
      return;
    }

    if (hasActionReadAuthority()) {
      elements["approval-locked"].hidden = true;
      elements["approval-workspace"].hidden = false;
      elements["approval-refresh"].hidden = false;
      badge(elements["approval-status"], "Exact review", "good");
      if (state.actionPlans === null && !state.actionLoading) {
        loadActionPlans();
      }
    } else {
      clearApprovalData("No action plans are retained without approval-read authority.");
      renderApprovalLocked(
        "Not authorized",
        "This session does not have the exact action-plan read capability."
      );
    }

    if (hasReceiptReadAuthority()) {
      elements["receipt-locked"].hidden = true;
      elements["receipt-workspace"].hidden = false;
      elements["receipt-refresh"].hidden = false;
      badge(elements["receipt-status"], "Metadata only", "good");
      if (state.receipts === null && !state.receiptLoading) {
        loadReceipts();
      }
    } else {
      clearReceiptData("No receipt metadata is retained without receipt-read authority.");
      renderReceiptLocked(
        "Not authorized",
        "This session does not have the exact receipt-read capability."
      );
    }

    renderActionComposerState();
    syncExecutionControls();
  }

  function renderApprovalLocked(status, message) {
    elements["approval-locked"].hidden = false;
    elements["approval-workspace"].hidden = true;
    elements["approval-refresh"].hidden = true;
    badge(elements["approval-status"], status, "neutral");
    notice(elements["approval-alert"], message, "neutral");
  }

  function renderReceiptLocked(status, message) {
    elements["receipt-locked"].hidden = false;
    elements["receipt-workspace"].hidden = true;
    elements["receipt-refresh"].hidden = true;
    badge(elements["receipt-status"], status, "neutral");
    notice(elements["receipt-alert"], message, "neutral");
  }

  function clearActionControlData(message) {
    clearApprovalData(message);
    clearReceiptData(message);
    resetActionComposerForFile(
      "Choose one exact fresh file before preparing actions."
    );
  }

  function clearApprovalData(message) {
    if (state.actionController) state.actionController.abort();
    state.actionController = null;
    state.actionLoading = false;
    state.actionPlans = null;
    state.selectedPlanId = null;
    state.actionPlan = null;
    elements["approval-list"].setAttribute("aria-busy", "false");
    elements["approval-refresh"].disabled = false;
    setText(elements["approval-count"], "0");
    renderWorkspaceEmpty(
      elements["approval-list"],
      message || "No action plans are retained on this page."
    );
    purgeApprovalDetailDom();
  }

  function clearReceiptData(message) {
    if (state.receiptController) state.receiptController.abort();
    state.receiptController = null;
    state.receiptLoading = false;
    state.receipts = null;
    state.selectedReceiptPlanId = null;
    state.receipt = null;
    elements["receipt-list"].setAttribute("aria-busy", "false");
    elements["receipt-refresh"].disabled = false;
    setText(elements["receipt-count"], "0");
    renderWorkspaceEmpty(
      elements["receipt-list"],
      message || "No receipt metadata is retained on this page."
    );
    purgeReceiptDetailDom();
  }

  function purgeApprovalDetailDom() {
    elements["approval-placeholder"].hidden = false;
    elements["approval-detail"].hidden = true;
    setText(elements["approval-plan-title"], "Action plan");
    badge(elements["approval-plan-state"], "Not loaded", "neutral");
    setText(elements["approval-plan-id"], "—");
    setText(elements["approval-file-ref"], "—");
    setText(elements["approval-expires-at"], "—");
    setText(elements["approval-digest"], "—");
    elements["approval-operations"].replaceChildren();
    elements["approval-acknowledge"].checked = false;
    elements["approval-acknowledge"].disabled = true;
    elements["approval-invalidate"].disabled = true;
    elements["approval-execute"].disabled = true;
    setText(
      elements["execution-gate-message"],
      "Choose one pending immutable plan before action-time approval."
    );
  }

  function purgeReceiptDetailDom() {
    elements["receipt-placeholder"].hidden = false;
    elements["receipt-detail"].hidden = true;
    setText(elements["receipt-detail-heading"], "Receipt");
    badge(elements["receipt-detail-state"], "Not loaded", "neutral");
    elements["receipt-detail-fields"].replaceChildren();
  }

  function resetActionComposerForFile(message) {
    state.actionDraft = [];
    elements["action-form"].reset();
    elements["action-type"].value = "jobnimbus.create_note";
    const taskSelect = elements["update-task-ref"];
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    setText(emptyOption, "Choose a task");
    taskSelect.replaceChildren(emptyOption);
    renderActionFields();
    renderActionComposerState();
    notice(
      elements["action-composer-alert"],
      message || "No action draft is retained.",
      "neutral"
    );
  }

  function clearActionDraft(message) {
    state.actionDraft = [];
    renderActionComposerState();
    notice(
      elements["action-composer-alert"],
      message || "The memory-only action draft was cleared.",
      "neutral"
    );
  }

  function renderActionFields() {
    const selectedType = elements["action-type"].value;
    document.querySelectorAll("[data-action-fields]").forEach(function (panel) {
      panel.hidden = panel.dataset.actionFields !== selectedType;
    });
  }

  function populateTaskOptions(tasks) {
    const select = elements["update-task-ref"];
    const fragment = document.createDocumentFragment();
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    setText(emptyOption, "Choose a task");
    fragment.append(emptyOption);
    tasks.forEach(function (task) {
      if (!TASK_REF.test(task.reference)) return;
      const option = document.createElement("option");
      option.value = task.reference;
      setText(
        option,
        (task.label || humanize(task.typeCode || "Task"))
          + (task.status ? " · " + humanize(task.status) : "")
      );
      fragment.append(option);
    });
    select.replaceChildren(fragment);
  }

  function renderActionComposerState() {
    const available = Boolean(
      navigator.onLine
      && hasActionPrepareAuthority()
      && state.fileReview
      && state.selectedFileRef
      && state.fileReview.file.fileRef === state.selectedFileRef
      && !state.fileLoading
    );
    const controls = elements["action-form"].querySelectorAll(
      "input, select, textarea, button"
    );
    controls.forEach(function (control) {
      control.disabled = !available || state.actionLoading;
    });
    if (
      available
      && elements["update-task-ref"].options.length <= 1
    ) {
      elements["update-task-ref"].disabled = true;
    }
    elements["action-draft-clear"].disabled =
      state.actionDraft.length === 0 || state.actionLoading;
    elements["action-prepare"].disabled =
      !available
      || state.actionLoading
      || state.actionDraft.length === 0;
    setText(
      elements["action-composer-count"],
      state.actionDraft.length + " / " + MAX_ACTIONS + " actions"
    );
    renderActionDraft();
    if (!available) {
      notice(
        elements["action-composer-alert"],
        state.fileReview
          ? "This session cannot prepare actions for the selected file."
          : "Open one exact fresh file before preparing actions.",
        "neutral"
      );
    } else if (state.actionDraft.length > 0) {
      notice(
        elements["action-composer-alert"],
        "The draft is memory only. Prepare it to create an immutable server review.",
        "good"
      );
    }
  }

  function addDraftAction(event) {
    event.preventDefault();
    if (
      !hasActionPrepareAuthority()
      || !state.fileReview
      || state.fileReview.file.fileRef !== state.selectedFileRef
    ) {
      notice(
        elements["action-composer-alert"],
        "Fresh exact-file authority is required before adding an action.",
        "bad"
      );
      return;
    }
    if (state.actionDraft.length >= MAX_ACTIONS) {
      notice(
        elements["action-composer-alert"],
        "A review batch may contain no more than 12 exact actions.",
        "warn"
      );
      return;
    }

    try {
      const operation = buildDraftOperation();
      state.actionDraft = state.actionDraft.concat([operation]);
      clearActionEntryFields(operation.type);
      renderActionComposerState();
    } catch (error) {
      notice(
        elements["action-composer-alert"],
        stringValue(error.message) || "Enter all required exact action material.",
        "warn"
      );
    }
  }

  function buildDraftOperation() {
    const type = elements["action-type"].value;
    if (!Object.hasOwn(ACTION_LABELS, type)) {
      throw new Error("That action is not enabled for HCN v1.");
    }

    if (type === "jobnimbus.create_note") {
      const note = exactMultilineText(elements["action-note"].value, 8192, "Enter the exact note.");
      return { type: type, input: { note: note } };
    }

    if (type === "jobnimbus.create_task") {
      const title = exactTitle(
        elements["create-task-title"].value,
        "Enter a task title without leading or trailing spaces."
      );
      const input = { title: title };
      const description = elements["create-task-description"].value;
      const dueDate = elements["create-task-due-date"].value;
      if (description) {
        input.description = exactMultilineText(
          description,
          4096,
          "The task description is not valid bounded text."
        );
      }
      if (dueDate) input.dueDate = exactIsoDate(dueDate);
      return { type: type, input: input };
    }

    if (type === "jobnimbus.update_task") {
      const taskRef = elements["update-task-ref"].value;
      if (!TASK_REF.test(taskRef)) {
        throw new Error("Choose a task from this fresh file.");
      }
      const input = { taskRef: taskRef };
      let changes = 0;
      const title = elements["update-task-title"].value;
      const description = elements["update-task-description"].value;
      const dueDate = elements["update-task-due-date"].value;
      const completed = elements["update-task-completed"].value;
      if (title) {
        input.title = exactTitle(
          title,
          "The new task title cannot have leading or trailing spaces."
        );
        changes += 1;
      }
      if (description) {
        input.description = exactMultilineText(
          description,
          4096,
          "The new task description is not valid bounded text."
        );
        changes += 1;
      }
      if (dueDate) {
        input.dueDate = exactIsoDate(dueDate);
        changes += 1;
      }
      if (completed === "true" || completed === "false") {
        input.completed = completed === "true";
        changes += 1;
      }
      if (changes === 0) {
        throw new Error("Enter at least one exact task change.");
      }
      return { type: type, input: input };
    }

    if (type === "jobnimbus.update_status") {
      const status = exactSingleLineText(
        elements["action-status"].value,
        128,
        "Enter the requested JobNimbus status."
      );
      return { type: type, input: { status: status } };
    }

    const dateOfLoss = exactIsoDate(elements["action-date-of-loss"].value);
    return { type: type, input: { dateOfLoss: dateOfLoss } };
  }

  function exactTitle(value, message) {
    if (
      typeof value !== "string"
      || !value
      || value !== value.trim()
      || Array.from(value).length > 256
      || /[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(value)
    ) {
      throw new Error(message);
    }
    return value;
  }

  function exactSingleLineText(value, maximum, message) {
    const text = typeof value === "string" ? value.trim() : "";
    if (
      !text
      || Array.from(text).length > maximum
      || /[\r\n\u2028\u2029\u0000-\u001f\u007f]/.test(text)
    ) {
      throw new Error(message);
    }
    return text;
  }

  function exactMultilineText(value, maximumBytes, message) {
    if (
      typeof value !== "string"
      || value.trim().length === 0
      || new TextEncoder().encode(value).length > maximumBytes
      || /[\u0000\u0008\u000b\u000c\u007f]/.test(value)
    ) {
      throw new Error(message);
    }
    return value;
  }

  function exactIsoDate(value) {
    if (!ISO_DATE.test(String(value || ""))) {
      throw new Error("Choose a real date in YYYY-MM-DD format.");
    }
    const date = new Date(value + "T00:00:00.000Z");
    if (
      Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== value
    ) {
      throw new Error("Choose a real date in YYYY-MM-DD format.");
    }
    return value;
  }

  function clearActionEntryFields(type) {
    const ids = {
      "jobnimbus.create_note": ["action-note"],
      "jobnimbus.create_task": [
        "create-task-title",
        "create-task-description",
        "create-task-due-date"
      ],
      "jobnimbus.update_task": [
        "update-task-ref",
        "update-task-title",
        "update-task-description",
        "update-task-due-date",
        "update-task-completed"
      ],
      "jobnimbus.update_status": ["action-status"],
      "jobnimbus.update_contact": ["action-date-of-loss"]
    };
    (ids[type] || []).forEach(function (id) {
      elements[id].value = "";
    });
  }

  function renderActionDraft() {
    if (!state.actionDraft.length) {
      renderRecentEmpty(
        elements["action-draft-list"],
        "No actions have been added."
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    state.actionDraft.forEach(function (operation, index) {
      const card = document.createElement("article");
      const heading = document.createElement("div");
      const title = document.createElement("strong");
      const number = document.createElement("span");
      const remove = document.createElement("button");
      card.className = "draft-action";
      heading.className = "draft-action-heading";
      setText(title, ACTION_LABELS[operation.type]);
      setText(number, "Action " + (index + 1));
      heading.append(title, number);
      card.append(heading);
      card.append(createMaterialList(operation.type, operation.input));
      remove.type = "button";
      remove.className = "text-button draft-remove";
      remove.disabled = state.actionLoading;
      setText(remove, "Remove action");
      remove.addEventListener("click", function () {
        state.actionDraft = state.actionDraft.filter(function (_item, itemIndex) {
          return itemIndex !== index;
        });
        renderActionComposerState();
      });
      card.append(remove);
      fragment.append(card);
    });
    elements["action-draft-list"].replaceChildren(fragment);
  }

  function createMaterialList(type, material) {
    const list = document.createElement("dl");
    list.className = "material-list";
    materialRows(type, material).forEach(function (row) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      setText(term, row[0]);
      setText(detail, row[1]);
      wrapper.append(term, detail);
      list.append(wrapper);
    });
    return list;
  }

  function materialRows(type, material) {
    const source = record(material);
    if (type === "jobnimbus.create_note") {
      return [["Exact note", source.note]];
    }
    if (type === "jobnimbus.create_task") {
      return [
        ["Title", source.title],
        ["Description", source.description],
        ["Due date", source.dueDate]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    if (type === "jobnimbus.update_task") {
      return [
        ["Task reference", source.taskRef],
        ["New title", source.title],
        ["New description", source.description],
        ["New due date", source.dueDate],
        [
          "Completion",
          source.completed === true
            ? "Mark complete"
            : source.completed === false
              ? "Mark open"
              : undefined
        ]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    if (type === "jobnimbus.update_status") {
      return [
        ["Requested status", source.requestedStatus || source.status],
        ["Resolved status", source.resolvedStatus]
      ].filter(function (row) {
        return row[1] !== undefined && row[1] !== "";
      });
    }
    return [["Date of loss", source.dateOfLoss]];
  }

  async function prepareActionPlan() {
    if (
      state.actionLoading
      || !hasActionPrepareAuthority()
      || !state.selectedFileRef
      || !state.fileReview
      || state.actionDraft.length === 0
    ) {
      return;
    }
    const fileRef = state.selectedFileRef;
    const operations = state.actionDraft.map(function (operation) {
      return {
        type: operation.type,
        input: { ...operation.input }
      };
    });
    const controller = new AbortController();
    if (state.actionController) state.actionController.abort();
    state.actionController = controller;
    state.actionLoading = true;
    renderActionComposerState();
    badge(elements["approval-status"], "Preparing", "neutral");
    notice(
      elements["approval-alert"],
      "Preparing a server-validated immutable dry run. No effects are running.",
      "neutral"
    );
    let preparedPlanId = "";

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionPrepare,
        { fileRef: fileRef, operations: operations },
        controller.signal,
        ACTION_PREPARE_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const plan = normalizePlanResponse(response, true);
      preparedPlanId = plan.planId;
      state.actionPlan = plan;
      state.selectedPlanId = plan.planId;
      state.actionPlans = upsertPlanSummary(state.actionPlans || [], plan);
      state.actionDraft = [];
      renderActionPlanList();
      renderActionPlanDetail(plan);
      notice(
        elements["approval-alert"],
        "Immutable review prepared. Nothing has been executed.",
        "good"
      );
      document.getElementById("approvals").scrollIntoView({ block: "start" });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "prepare"),
        "bad"
      );
      notice(
        elements["action-composer-alert"],
        "The draft remains in memory because preparation did not complete.",
        "warn"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        renderActionComposerState();
        syncExecutionControls();
      }
    }
    if (preparedPlanId && hasActionReadAuthority()) {
      await loadActionPlans({ selectPlanId: preparedPlanId });
    }
  }

  async function loadActionPlans(options) {
    if (state.actionLoading || !hasActionReadAuthority() || !navigator.onLine) {
      return;
    }
    const requestedPlanId = PLAN_ID.test(String(options?.selectPlanId || ""))
      ? options.selectPlanId
      : state.selectedPlanId;
    if (state.actionController) state.actionController.abort();
    const controller = new AbortController();
    state.actionController = controller;
    state.actionLoading = true;
    elements["approval-list"].setAttribute("aria-busy", "true");
    elements["approval-refresh"].disabled = true;
    badge(elements["approval-status"], "Loading", "neutral");
    notice(elements["approval-alert"], "Loading current session action plans.", "neutral");
    let detailPlanId = "";

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionList,
        {},
        controller.signal,
        ACTION_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      state.actionPlans = normalizePlanListResponse(response);
      const selected = state.actionPlans.find(function (plan) {
        return plan.planId === requestedPlanId;
      }) || state.actionPlans.find(function (plan) {
        return plan.status === "pending";
      }) || state.actionPlans[0];
      state.selectedPlanId = selected ? selected.planId : null;
      state.actionPlan = null;
      renderActionPlanList();
      if (selected) {
        detailPlanId = selected.planId;
      } else {
        purgeApprovalDetailDom();
      }
      badge(
        elements["approval-status"],
        state.actionPlans.length + " plan" + (state.actionPlans.length === 1 ? "" : "s"),
        "good"
      );
      notice(
        elements["approval-alert"],
        state.actionPlans.length
          ? "Choose a plan to inspect its exact immutable material."
          : "There are no action plans for this browser session.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.actionPlans = null;
      state.selectedPlanId = null;
      state.actionPlan = null;
      renderWorkspaceEmpty(
        elements["approval-list"],
        "Action plans could not be loaded. No stale list is shown."
      );
      purgeApprovalDetailDom();
      badge(elements["approval-status"], "Unavailable", "bad");
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "list"),
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        elements["approval-list"].setAttribute("aria-busy", "false");
        elements["approval-refresh"].disabled = false;
        renderActionPlanList();
        renderActionComposerState();
      }
    }
    if (detailPlanId && hasActionReadAuthority()) {
      await loadActionPlanDetail(detailPlanId);
    }
  }

  async function loadActionPlanDetail(planId) {
    if (
      state.actionLoading
      || !hasActionReadAuthority()
      || !PLAN_ID.test(String(planId || ""))
    ) {
      return;
    }
    if (state.actionController) state.actionController.abort();
    const controller = new AbortController();
    state.actionController = controller;
    state.actionLoading = true;
    state.selectedPlanId = planId;
    state.actionPlan = null;
    elements["approval-acknowledge"].checked = false;
    renderActionPlanList();
    purgeApprovalDetailDom();
    notice(elements["approval-alert"], "Loading exact immutable plan detail.", "neutral");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionDetail,
        { planId: planId },
        controller.signal,
        ACTION_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const plan = normalizePlanResponse(response, true);
      if (plan.planId !== planId) throw new Error("Plan detail did not match");
      state.actionPlan = plan;
      state.actionPlans = upsertPlanSummary(state.actionPlans || [], plan);
      renderActionPlanList();
      renderActionPlanDetail(plan);
      notice(
        elements["approval-alert"],
        "Exact server-prepared plan loaded. Review every field before approval.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.actionPlan = null;
      purgeApprovalDetailDom();
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "detail"),
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        syncExecutionControls();
        renderActionComposerState();
      }
    }
  }

  function normalizePlanListResponse(value) {
    assertNoStoreEnvelope(value);
    if (!Array.isArray(value.plans)) {
      throw new Error("Invalid action plan list");
    }
    return value.plans.slice(0, 50).map(function (plan) {
      return normalizeActionPlan(plan, false);
    });
  }

  function normalizePlanResponse(value, requireOperations) {
    assertNoStoreEnvelope(value);
    const plan = record(value.plan);
    if (!Object.keys(plan).length) {
      throw new Error("Invalid action plan response");
    }
    return normalizeActionPlan(plan, requireOperations);
  }

  function normalizeActionPlan(value, requireOperations) {
    const plan = record(value);
    const planId = boundedString(plan.planId, 80);
    const fileRef = boundedString(plan.fileRef, 80);
    const approvalDigest = boundedString(plan.approvalDigest, 80);
    const approvalExpiresAt = boundedString(plan.approvalExpiresAt, 40);
    const status = boundedString(plan.status, 64);
    const file = record(plan.file);
    let fileDisplayLabel = "";
    if (Object.keys(file).length) {
      if (
        boundedString(file.reference, 80) !== fileRef
        || !boundedString(file.displayLabel, 256)
      ) {
        throw new Error("Invalid action plan file");
      }
      fileDisplayLabel = boundedString(file.displayLabel, 256);
    }
    if (
      !PLAN_ID.test(planId)
      || !FILE_REF.test(fileRef)
      || !APPROVAL_DIGEST.test(approvalDigest)
      || !validIsoInstant(approvalExpiresAt)
      || !PLAN_STATUSES.has(status)
      || !Number.isInteger(plan.operationCount)
      || plan.operationCount < 1
      || plan.operationCount > MAX_ACTIONS
      || !validIsoInstant(plan.createdAt)
      || !validIsoInstant(plan.updatedAt)
    ) {
      throw new Error("Invalid action plan");
    }
    let operations = null;
    if (Array.isArray(plan.operations)) {
      if (plan.operations.length !== plan.operationCount) {
        throw new Error("Invalid action plan operations");
      }
      operations = plan.operations.map(normalizePlanOperation);
    } else if (requireOperations) {
      throw new Error("Exact action plan material is unavailable");
    }
    return {
      planId: planId,
      fileRef: fileRef,
      fileDisplayLabel: fileDisplayLabel,
      approvalDigest: approvalDigest,
      approvalExpiresAt: approvalExpiresAt,
      status: status,
      operationCount: plan.operationCount,
      operations: operations,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt
    };
  }

  function normalizePlanOperation(value, arrayIndex) {
    const operation = record(value);
    const type = boundedString(operation.type, 128);
    const action = boundedString(operation.action, 160);
    const index = operation.index;
    if (
      !Object.hasOwn(ACTION_LABELS, type)
      || !action
      || !Number.isInteger(index)
      || index !== arrayIndex
    ) {
      throw new Error("Invalid action plan operation");
    }
    const source = record(operation.material);
    const material = {};
    const allowed = {
      "jobnimbus.create_note": ["note"],
      "jobnimbus.create_task": ["title", "description", "dueDate"],
      "jobnimbus.update_task": [
        "taskRef",
        "title",
        "description",
        "dueDate",
        "completed"
      ],
      "jobnimbus.update_status": ["requestedStatus", "resolvedStatus"],
      "jobnimbus.update_contact": ["dateOfLoss"]
    }[type];
    if (Object.keys(source).some(function (key) {
      return !allowed.includes(key);
    })) {
      throw new Error("Invalid action material");
    }
    allowed.forEach(function (key) {
      if (!Object.hasOwn(source, key)) return;
      if (key === "completed") {
        if (typeof source[key] !== "boolean") {
          throw new Error("Invalid action material");
        }
        material[key] = source[key];
        return;
      }
      if (typeof source[key] !== "string" || source[key].length > 8192) {
        throw new Error("Invalid action material");
      }
      material[key] = source[key];
    });
    if (
      (type === "jobnimbus.create_note" && !material.note)
      || (type === "jobnimbus.create_task" && !material.title)
      || (type === "jobnimbus.update_task" && !TASK_REF.test(material.taskRef || ""))
      || (
        type === "jobnimbus.update_status"
        && (!material.requestedStatus || !material.resolvedStatus)
      )
      || (
        type === "jobnimbus.update_contact"
        && !ISO_DATE.test(material.dateOfLoss || "")
      )
    ) {
      throw new Error("Incomplete action material");
    }
    return {
      index: index,
      type: type,
      action: action,
      material: material
    };
  }

  function assertNoStoreEnvelope(value) {
    const authority = record(record(value).authority);
    if (
      !isRecord(value)
      || value.schema !== "hcn.console.actions.v1"
      || !validIsoInstant(value.generatedAt)
      || value.ephemeral !== true
      || value.cachePolicy !== "no_store"
      || authority.mode !== "explicit_chance_approval"
      || authority.automaticExecution !== false
      || authority.automaticRetry !== false
      || authority.providerIdentifiersExposed !== false
    ) {
      throw new Error("Invalid no-store response");
    }
  }

  function upsertPlanSummary(plans, plan) {
    const summary = {
      ...plan,
      operations: null
    };
    return [summary].concat(plans.filter(function (candidate) {
      return candidate.planId !== plan.planId;
    })).slice(0, 50);
  }

  function renderActionPlanList() {
    const plans = Array.isArray(state.actionPlans) ? state.actionPlans : [];
    setText(elements["approval-count"], String(plans.length));
    if (!plans.length) {
      renderWorkspaceEmpty(elements["approval-list"], "No action plans are available.");
      return;
    }
    const fragment = document.createDocumentFragment();
    plans.forEach(function (plan) {
      const button = document.createElement("button");
      const title = document.createElement("strong");
      const status = document.createElement("span");
      const expiry = document.createElement("span");
      button.type = "button";
      button.className = "approval-list-item";
      if (plan.planId === state.selectedPlanId) {
        button.classList.add("is-selected");
        button.setAttribute("aria-pressed", "true");
      } else {
        button.setAttribute("aria-pressed", "false");
      }
      button.disabled = state.actionLoading;
      setText(
        title,
        plan.fileDisplayLabel
          || plan.operationCount + " action" + (plan.operationCount === 1 ? "" : "s")
      );
      setText(status, humanize(plan.status) + " · " + plan.planId);
      setText(expiry, "Expires " + readableDateTime(plan.approvalExpiresAt));
      button.append(title, status, expiry);
      button.addEventListener("click", function () {
        loadActionPlanDetail(plan.planId);
      });
      fragment.append(button);
    });
    elements["approval-list"].replaceChildren(fragment);
  }

  function renderActionPlanDetail(plan) {
    elements["approval-placeholder"].hidden = true;
    elements["approval-detail"].hidden = false;
    setText(
      elements["approval-plan-title"],
      plan.operationCount + " exact action" + (plan.operationCount === 1 ? "" : "s")
    );
    badge(
      elements["approval-plan-state"],
      humanize(plan.status),
      planStatusTone(plan.status)
    );
    setText(elements["approval-plan-id"], plan.planId);
    setText(
      elements["approval-file-ref"],
      plan.fileDisplayLabel
        ? plan.fileDisplayLabel + " · " + plan.fileRef
        : plan.fileRef
    );
    setText(
      elements["approval-expires-at"],
      readableDateTime(plan.approvalExpiresAt) + " · " + plan.approvalExpiresAt
    );
    setText(elements["approval-digest"], plan.approvalDigest);
    const fragment = document.createDocumentFragment();
    plan.operations.forEach(function (operation) {
      const card = document.createElement("article");
      const heading = document.createElement("div");
      const title = document.createElement("strong");
      const number = document.createElement("span");
      card.className = "approval-operation";
      heading.className = "approval-operation-heading";
      setText(title, operation.action || ACTION_LABELS[operation.type]);
      setText(number, "Action " + (operation.index + 1));
      heading.append(title, number);
      card.append(heading, createMaterialList(operation.type, operation.material));
      fragment.append(card);
    });
    elements["approval-operations"].replaceChildren(fragment);
    elements["approval-acknowledge"].checked = false;
    syncExecutionControls();
  }

  function runtimeGateEnabled(key) {
    return record(record(record(state.meta).runtime).gates)[key] === "enabled";
  }

  function canExecuteSelectedPlan() {
    const plan = state.actionPlan;
    return Boolean(
      navigator.onLine
      && hasActionReadAuthority()
      && sessionCapabilities().includes(ACTION_EXECUTE_CAPABILITY)
      && runtimeGateEnabled("externalWrites")
      && runtimeGateEnabled("hcnActionExecution")
      && plan
      && plan.status === "pending"
      && Date.parse(plan.approvalExpiresAt) > Date.now()
      && !state.actionLoading
    );
  }

  function syncExecutionControls() {
    const plan = state.actionPlan;
    const executable = canExecuteSelectedPlan();
    const pending = Boolean(plan && plan.status === "pending");
    const canInvalidate = Boolean(
      navigator.onLine
      && pending
      && hasActionInvalidateAuthority()
      && !state.actionLoading
    );
    elements["approval-invalidate"].disabled = !canInvalidate;
    elements["approval-acknowledge"].disabled = !executable;
    if (!executable) elements["approval-acknowledge"].checked = false;
    elements["approval-execute"].disabled =
      !executable || !elements["approval-acknowledge"].checked;

    let message = "Choose one pending immutable plan before action-time approval.";
    if (plan && plan.status !== "pending") {
      message = "This plan is " + humanize(plan.status) + " and cannot be executed.";
    } else if (plan && Date.parse(plan.approvalExpiresAt) <= Date.now()) {
      message = "This approval expired. Prepare and review a fresh unchanged plan.";
    } else if (plan && !sessionCapabilities().includes(ACTION_EXECUTE_CAPABILITY)) {
      message = "This session does not have the exact action-execution capability.";
    } else if (plan && !runtimeGateEnabled("externalWrites")) {
      message = "The global external-writes gate is disabled.";
    } else if (plan && !runtimeGateEnabled("hcnActionExecution")) {
      message = "The separate HCN action-execution gate is disabled.";
    } else if (plan && executable) {
      message = "Both effect gates and the exact execution capability are enabled.";
    }
    setText(elements["execution-gate-message"], message);
  }

  async function invalidateSelectedPlan() {
    const plan = state.actionPlan;
    if (
      state.actionLoading
      || !plan
      || plan.status !== "pending"
      || !hasActionInvalidateAuthority()
    ) {
      return;
    }
    const controller = new AbortController();
    if (state.actionController) state.actionController.abort();
    state.actionController = controller;
    state.actionLoading = true;
    elements["approval-acknowledge"].checked = false;
    syncExecutionControls();
    notice(elements["approval-alert"], "Invalidating this pending plan.", "neutral");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.actionInvalidate,
        { planId: plan.planId },
        controller.signal,
        ACTION_INVALIDATE_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const updated = normalizePlanResponse(response, true);
      if (updated.planId !== plan.planId) throw new Error("Plan did not match");
      state.actionPlan = updated;
      state.actionPlans = upsertPlanSummary(state.actionPlans || [], updated);
      renderActionPlanList();
      renderActionPlanDetail(updated);
      notice(
        elements["approval-alert"],
        "The pending plan was invalidated. It cannot be executed.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      notice(
        elements["approval-alert"],
        actionPlanErrorMessage(error, "invalidate"),
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        syncExecutionControls();
      }
    }
  }

  async function executeSelectedPlan() {
    const plan = state.actionPlan;
    if (state.actionLoading || !plan) {
      return;
    }
    if (!canExecuteSelectedPlan()) {
      syncExecutionControls();
      notice(
        elements["approval-alert"],
        "This plan is no longer executable. Prepare and review a fresh plan if needed.",
        "warn"
      );
      return;
    }
    if (elements["approval-acknowledge"].checked !== true) {
      return;
    }
    const planId = plan.planId;
    const controller = new AbortController();
    if (state.actionController) state.actionController.abort();
    state.actionController = controller;
    state.actionLoading = true;
    elements["approval-acknowledge"].checked = false;
    syncExecutionControls();
    badge(elements["approval-status"], "Executing", "neutral");
    notice(
      elements["approval-alert"],
      "Executing the exact acknowledged plan once. Do not repeat this action.",
      "warn"
    );
    let completed = false;

    try {
      await postOperationalJson(
        ENDPOINTS.actionExecute,
        { planId: planId },
        controller.signal,
        ACTION_EXECUTE_CAPABILITY
      );
      if (controller.signal.aborted) return;
      completed = true;
      notice(
        elements["approval-alert"],
        "The execution request completed. Refreshing plan and receipt metadata.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      notice(
        elements["approval-alert"],
        "The outcome could not be confirmed. Do not retry. Refresh receipts and reconcile against fresh JobNimbus evidence.",
        "bad"
      );
    } finally {
      if (state.actionController === controller) {
        state.actionController = null;
        state.actionLoading = false;
        renderActionPlanList();
        syncExecutionControls();
      }
    }
    if (completed) {
      await Promise.all([
        loadActionPlans({ selectPlanId: planId }),
        loadReceipts({ selectPlanId: planId })
      ]);
    }
  }

  async function loadReceipts(options) {
    if (state.receiptLoading || !hasReceiptReadAuthority() || !navigator.onLine) {
      return;
    }
    const requestedPlanId = PLAN_ID.test(String(options?.selectPlanId || ""))
      ? options.selectPlanId
      : state.selectedReceiptPlanId;
    if (state.receiptController) state.receiptController.abort();
    const controller = new AbortController();
    state.receiptController = controller;
    state.receiptLoading = true;
    elements["receipt-list"].setAttribute("aria-busy", "true");
    elements["receipt-refresh"].disabled = true;
    badge(elements["receipt-status"], "Loading", "neutral");
    notice(elements["receipt-alert"], "Loading durable receipt metadata.", "neutral");
    let detailPlanId = "";

    try {
      const response = await postOperationalJson(
        ENDPOINTS.receiptList,
        {},
        controller.signal,
        RECEIPT_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      state.receipts = normalizeReceiptListResponse(response);
      const selected = state.receipts.find(function (receipt) {
        return receipt.planId === requestedPlanId;
      }) || state.receipts[0];
      state.selectedReceiptPlanId = selected ? selected.planId : null;
      state.receipt = null;
      renderReceiptList();
      if (selected) {
        detailPlanId = selected.planId;
      } else {
        purgeReceiptDetailDom();
      }
      badge(
        elements["receipt-status"],
        state.receipts.length + " receipt" + (state.receipts.length === 1 ? "" : "s"),
        "good"
      );
      notice(
        elements["receipt-alert"],
        state.receipts.length
          ? "Choose a receipt to inspect its bounded outcome metadata."
          : "There are no durable receipts for this HCN operator.",
        "good"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.receipts = null;
      state.selectedReceiptPlanId = null;
      state.receipt = null;
      renderWorkspaceEmpty(
        elements["receipt-list"],
        "Receipt metadata could not be loaded. No stale list is shown."
      );
      purgeReceiptDetailDom();
      badge(elements["receipt-status"], "Unavailable", "bad");
      notice(elements["receipt-alert"], receiptErrorMessage(error), "bad");
    } finally {
      if (state.receiptController === controller) {
        state.receiptController = null;
        state.receiptLoading = false;
        elements["receipt-list"].setAttribute("aria-busy", "false");
        elements["receipt-refresh"].disabled = false;
        renderReceiptList();
      }
    }
    if (detailPlanId && hasReceiptReadAuthority()) {
      await loadReceiptDetail(detailPlanId);
    }
  }

  async function loadReceiptDetail(planId) {
    if (
      state.receiptLoading
      || !hasReceiptReadAuthority()
      || !PLAN_ID.test(String(planId || ""))
    ) {
      return;
    }
    if (state.receiptController) state.receiptController.abort();
    const controller = new AbortController();
    state.receiptController = controller;
    state.receiptLoading = true;
    state.selectedReceiptPlanId = planId;
    state.receipt = null;
    renderReceiptList();
    purgeReceiptDetailDom();
    notice(elements["receipt-alert"], "Loading exact receipt metadata.", "neutral");

    try {
      const response = await postOperationalJson(
        ENDPOINTS.receiptDetail,
        { planId: planId },
        controller.signal,
        RECEIPT_READ_CAPABILITY
      );
      if (controller.signal.aborted) return;
      const receipt = normalizeReceiptResponse(response);
      if (receipt.planId !== planId) throw new Error("Receipt did not match");
      state.receipt = receipt;
      state.receipts = upsertReceipt(state.receipts || [], receipt);
      renderReceiptList();
      renderReceiptDetail(receipt);
      const receiptNotice = receiptOutcomeNotice(receipt.status);
      notice(
        elements["receipt-alert"],
        receiptNotice.message,
        receiptNotice.tone
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (isAuthorizationStatus(error)) {
        handleOperationalAuthLoss();
        return;
      }
      state.receipt = null;
      purgeReceiptDetailDom();
      notice(elements["receipt-alert"], receiptErrorMessage(error), "bad");
    } finally {
      if (state.receiptController === controller) {
        state.receiptController = null;
        state.receiptLoading = false;
        renderReceiptList();
      }
    }
  }

  function normalizeReceiptListResponse(value) {
    assertNoStoreEnvelope(value);
    if (!Array.isArray(value.receipts)) {
      throw new Error("Invalid receipt list");
    }
    return value.receipts.slice(0, 100).map(normalizeReceipt);
  }

  function normalizeReceiptResponse(value) {
    assertNoStoreEnvelope(value);
    const receipt = record(value.receipt);
    if (!Object.keys(receipt).length) throw new Error("Invalid receipt response");
    return normalizeReceipt(receipt);
  }

  function normalizeReceipt(value) {
    const receipt = record(value);
    const fileRef = boundedString(receipt.fileRef, 80);
    const planId = boundedString(receipt.planId, 80);
    const digest = boundedString(receipt.digest, 80);
    const batchRef = boundedString(receipt.batchRef, 80);
    const status = boundedString(receipt.status, 64);
    const counts = [
      receipt.succeededCount,
      receipt.failedCount,
      receipt.blockedCount,
      receipt.unknownCount
    ];
    if (
      !FILE_REF.test(fileRef)
      || !PLAN_ID.test(planId)
      || !APPROVAL_DIGEST.test(digest)
      || !BATCH_REF.test(batchRef)
      || !RECEIPT_STATUSES.has(status)
      || !Number.isInteger(receipt.operationCount)
      || receipt.operationCount < 1
      || receipt.operationCount > MAX_ACTIONS
      || counts.some(function (count) {
        return !Number.isInteger(count) || count < 0 || count > MAX_ACTIONS;
      })
      || counts.reduce(function (sum, count) {
        return sum + count;
      }, 0) !== receipt.operationCount
      || !validIsoInstant(receipt.createdAt)
      || !validIsoInstant(receipt.updatedAt)
      || !validIsoInstant(receipt.executingAt)
      || (
        receipt.terminalAt !== undefined
        && !validIsoInstant(receipt.terminalAt)
      )
    ) {
      throw new Error("Invalid receipt metadata");
    }
    return {
      fileRef: fileRef,
      planId: planId,
      digest: digest,
      batchRef: batchRef,
      status: status,
      operationCount: receipt.operationCount,
      succeededCount: receipt.succeededCount,
      failedCount: receipt.failedCount,
      blockedCount: receipt.blockedCount,
      unknownCount: receipt.unknownCount,
      createdAt: receipt.createdAt,
      updatedAt: receipt.updatedAt,
      executingAt: receipt.executingAt,
      terminalAt: receipt.terminalAt || ""
    };
  }

  function upsertReceipt(receipts, receipt) {
    return [receipt].concat(receipts.filter(function (candidate) {
      return candidate.planId !== receipt.planId;
    })).slice(0, 100);
  }

  function renderReceiptList() {
    const receipts = Array.isArray(state.receipts) ? state.receipts : [];
    setText(elements["receipt-count"], String(receipts.length));
    if (!receipts.length) {
      renderWorkspaceEmpty(elements["receipt-list"], "No receipt metadata is available.");
      return;
    }
    const fragment = document.createDocumentFragment();
    receipts.forEach(function (receipt) {
      const button = document.createElement("button");
      const title = document.createElement("strong");
      const status = document.createElement("span");
      const updated = document.createElement("span");
      button.type = "button";
      button.className = "receipt-list-item";
      if (receipt.planId === state.selectedReceiptPlanId) {
        button.classList.add("is-selected");
        button.setAttribute("aria-pressed", "true");
      } else {
        button.setAttribute("aria-pressed", "false");
      }
      button.disabled = state.receiptLoading;
      setText(title, humanize(receipt.status));
      setText(status, receipt.operationCount + " action outcome · " + receipt.planId);
      setText(updated, "Updated " + readableDateTime(receipt.updatedAt));
      button.append(title, status, updated);
      button.addEventListener("click", function () {
        loadReceiptDetail(receipt.planId);
      });
      fragment.append(button);
    });
    elements["receipt-list"].replaceChildren(fragment);
  }

  function renderReceiptDetail(receipt) {
    elements["receipt-placeholder"].hidden = true;
    elements["receipt-detail"].hidden = false;
    setText(elements["receipt-detail-heading"], receipt.batchRef);
    badge(
      elements["receipt-detail-state"],
      humanize(receipt.status),
      planStatusTone(receipt.status)
    );
    const rows = [
      ["Plan", receipt.planId, false],
      ["File", receipt.fileRef, false],
      ["Batch", receipt.batchRef, false],
      ["Status", humanize(receipt.status), false],
      ["Operation count", String(receipt.operationCount), false],
      ["Succeeded", String(receipt.succeededCount), false],
      ["Failed", String(receipt.failedCount), false],
      ["Blocked", String(receipt.blockedCount), false],
      ["Unknown", String(receipt.unknownCount), false],
      ["Execution started", readableDateTime(receipt.executingAt), false],
      [
        receipt.terminalAt ? "Terminal at" : "Last updated",
        readableDateTime(receipt.terminalAt || receipt.updatedAt),
        false
      ],
      ["Approval digest", receipt.digest, true]
    ];
    const fragment = document.createDocumentFragment();
    rows.forEach(function (row) {
      const wrapper = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      if (row[2]) wrapper.dataset.wide = "true";
      setText(term, row[0]);
      setText(detail, row[1]);
      wrapper.append(term, detail);
      fragment.append(wrapper);
    });
    elements["receipt-detail-fields"].replaceChildren(fragment);
  }

  function validIsoInstant(value) {
    if (typeof value !== "string" || value.length > 40) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function planStatusTone(status) {
    if (status === "executed") return "good";
    if (
      status === "completed_pending_verification"
      || status === "executing"
      || status === "blocked_duplicate"
    ) return "warn";
    if (
      status === "failed"
      || status === "partial_failure"
      || status === "reconciliation_required"
    ) {
      return "bad";
    }
    return "neutral";
  }

  function receiptOutcomeNotice(status) {
    if (status === "executed") {
      return {
        message: "Readback-confirmed execution metadata loaded.",
        tone: "good"
      };
    }
    if (status === "completed_pending_verification") {
      return {
        message:
          "The actions were accepted, but fresh JobNimbus verification is still required. Do not repeat them.",
        tone: "warn"
      };
    }
    if (status === "executing") {
      return {
        message:
          "Execution has no terminal receipt yet. Do not retry; reconcile against fresh source evidence.",
        tone: "warn"
      };
    }
    if (status === "reconciliation_required") {
      return {
        message:
          "This outcome requires reconciliation against fresh source evidence. Do not retry it.",
        tone: "warn"
      };
    }
    if (status === "partial_failure" || status === "failed") {
      return {
        message:
          "The batch did not fully complete. Review fresh evidence and its receipt before any new action.",
        tone: "bad"
      };
    }
    if (status === "blocked_duplicate") {
      return {
        message:
          "A duplicate execution was blocked. Review the prior durable outcome before any new action.",
        tone: "warn"
      };
    }
    return {
      message: "Durable outcome metadata loaded. No retry is assumed.",
      tone: "neutral"
    };
  }

  function actionPlanErrorMessage(error, action) {
    const status = statusOf(error);
    if (status === 409) {
      return "The plan or exact file scope changed. Prepare and review a fresh plan.";
    }
    if (status === 429) {
      return "The action control plane is busy. Wait before making a fresh request.";
    }
    if (status === 502 || status === 503 || status === 507) {
      return "The action control plane is unavailable. No action is assumed.";
    }
    return "The action plan could not " + (
      action === "prepare" ? "be prepared." : action + " safely."
    );
  }

  function receiptErrorMessage(error) {
    const status = statusOf(error);
    if (status === 404) {
      return "That receipt is not available for this HCN operator.";
    }
    if (status === 502 || status === 503 || status === 507) {
      return "Durable receipt metadata is unavailable. No outcome is assumed.";
    }
    return "Receipt metadata could not be verified.";
  }

  function handleOperationalAuthLoss() {
    clearOperationalData("The operational session is no longer authorized.");
    state.session = null;
    state.sessionError = { status: 401 };
    renderSignedOut("Sign in again to verify your exact operating scope.");
    renderOperationsLocked(
      "Session expired",
      "Client data was cleared. Sign in again before requesting fresh evidence."
    );
    renderOverallState();
  }

  function isAuthorizationStatus(error) {
    return statusOf(error) === 401 || statusOf(error) === 403;
  }

  function workCenterErrorMessage(error) {
    if (!navigator.onLine) return "The connection went offline. No client queue is retained.";
    if (statusOf(error) === 502 || statusOf(error) === 503) {
      return "Fresh JobNimbus evidence is unavailable. Try the queue again.";
    }
    return "The Work Center could not verify a fresh assigned-file queue.";
  }

  function fileErrorMessage(error) {
    if (!navigator.onLine) return "The connection went offline. File evidence was cleared.";
    if (statusOf(error) === 404) {
      return "That file is no longer in the current Chance-assigned queue. Refresh the queue.";
    }
    if (statusOf(error) === 502 || statusOf(error) === 503) {
      return "Fresh file evidence is unavailable. Try this exact file again.";
    }
    return "The exact file review could not be completed from fresh evidence.";
  }

  function renderCapabilityGroups(capabilities) {
    const groups = new Map();
    capabilities.forEach(function (capability) {
      const prefix = capability.split(".", 1)[0];
      groups.set(prefix, (groups.get(prefix) || 0) + 1);
    });

    const fragment = document.createDocumentFragment();
    Array.from(groups.entries()).sort(function (a, b) {
      return a[0].localeCompare(b[0]);
    }).forEach(function (entry) {
      const item = document.createElement("span");
      const label = document.createElement("span");
      const count = document.createElement("strong");
      item.className = "capability-group";
      setText(label, CAPABILITY_GROUP_LABELS[entry[0]] || humanize(entry[0]));
      setText(count, String(entry[1]));
      item.append(label, count);
      fragment.append(item);
    });

    elements["capability-groups"].replaceChildren(fragment);
  }

  function renderOverallState() {
    const metaReady = Boolean(state.meta) && !state.metaError;
    const sessionDenied = state.sessionError &&
      (statusOf(state.sessionError) === 401 || statusOf(state.sessionError) === 403);
    const sessionAuthorized = Boolean(
      state.session &&
      state.session.authenticated === true &&
      record(state.session.identity).authentication === "authenticated"
    );
    const sessionNeedsSignIn = sessionDenied || (Boolean(state.session) && !sessionAuthorized);
    const sessionReady = sessionAuthorized || sessionNeedsSignIn;

    if (!navigator.onLine) {
      setConnection("offline", "Offline");
      setText(elements["load-message"], "You are offline. Only the console shell may be available.");
      setText(elements["readiness-score"], "OFF");
      setText(elements["readiness-label"], "Connection unavailable");
      setText(elements["readiness-summary"], "Reconnect to verify fresh bridge and session status.");
      return;
    }

    if (metaReady && sessionReady) {
      setConnection("good", "Bridge ready");
      setText(
        elements["load-message"],
        sessionNeedsSignIn
          ? "Bridge verified. Sign in to check your operating permissions."
          : "Fresh platform and session checks complete."
      );
      setText(elements["readiness-score"], sessionNeedsSignIn ? "1/2" : "2/2");
      setText(
        elements["readiness-label"],
        sessionNeedsSignIn ? "Bridge ready · sign in next" : "Controlled operations ready"
      );
      setText(
        elements["readiness-summary"],
        sessionNeedsSignIn
          ? "The platform foundation is responding. Your authority remains closed until you sign in."
          : "The bridge, system boundaries, and your route-level authority have been checked fresh. The Work Center runs a separate fresh client-data read."
      );
      return;
    }

    setConnection("error", "Needs attention");
    setText(elements["load-message"], "One or more readiness checks could not be completed.");
    setText(elements["readiness-score"], "—");
    setText(elements["readiness-label"], "Readiness incomplete");
    setText(
      elements["readiness-summary"],
      "The console will not assume missing connector, gate, build, or authority information."
    );
  }

  function renderStatusItems(container, entries, toneForValue) {
    if (!entries.length) {
      renderEmpty(container, "No status fields were reported.");
      return;
    }

    const fragment = document.createDocumentFragment();
    entries.forEach(function (entry) {
      const item = document.createElement("div");
      const dot = document.createElement("span");
      const copy = document.createElement("span");
      const label = document.createElement("strong");
      const value = document.createElement("span");

      item.className = "status-item";
      item.dataset.tone = toneForValue(entry.value);
      dot.className = "status-item-dot";
      dot.setAttribute("aria-hidden", "true");
      copy.className = "status-item-copy";
      setText(label, entry.label);
      setText(value, humanize(entry.value || "unknown"));
      copy.append(label, value);
      item.append(dot, copy);
      fragment.append(item);
    });

    container.replaceChildren(fragment);
  }

  function renderEmpty(container, message) {
    const paragraph = document.createElement("p");
    paragraph.className = "empty-state";
    setText(paragraph, message);
    container.replaceChildren(paragraph);
  }

  function knownEntries(source, labels) {
    return Object.keys(labels).map(function (key) {
      return {
        key: key,
        label: labels[key],
        value: stringValue(source[key]) || "unknown"
      };
    });
  }

  function connectorTone(value) {
    if (value === "configured") return "good";
    if (value === "unconfigured") return "bad";
    return "neutral";
  }

  function gateTone(value) {
    if (value === "enabled") return "warn";
    if (value === "disabled") return "good";
    return "neutral";
  }

  function notice(element, message, tone) {
    setText(element, message);
    element.dataset.tone = tone;
  }

  function badge(element, message, tone) {
    setText(element, message);
    element.dataset.tone = tone;
  }

  function setConnection(tone, message) {
    elements["connection-status"].dataset.tone = tone;
    setText(elements["connection-status-text"], message);
  }

  function handleNetworkChange() {
    if (navigator.onLine) {
      loadPlatformState();
    } else {
      clearOperationalData("Client data was cleared when the connection went offline.");
      renderOperationsLocked(
        "Offline",
        "Reconnect to verify the session and request fresh evidence."
      );
      renderOverallState();
    }
  }

  function readableTime(value) {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function readableDateTime(value) {
    if (typeof value !== "string" || !value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(date);
  }

  function humanize(value) {
    return String(value || "unknown")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, function (letter) {
        return letter.toUpperCase();
      });
  }

  function statusOf(error) {
    return error && Number.isInteger(error.status) ? error.status : null;
  }

  function stringValue(value) {
    return typeof value === "string" && value.length <= 240 ? value : "";
  }

  function boundedString(value, maximum) {
    if (typeof value !== "string") return "";
    return Array.from(value).slice(0, maximum).join("");
  }

  function record(value) {
    return isRecord(value) ? value : {};
  }

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function setText(element, value) {
    element.textContent = String(value);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/hcn/sw.js", { scope: "/hcn/" }).catch(function () {
        // Offline support is optional; readiness remains sourced from live API checks.
      });
    });
  }
})();
