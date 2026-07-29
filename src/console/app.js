(function () {
  "use strict";

  const ENDPOINTS = Object.freeze({
    meta: "/api/v1/meta",
    session: "/hcn/auth/session",
    logout: "/hcn/auth/logout",
    workCenter: "/hcn/api/v1/work-center",
    fileReview: "/hcn/api/v1/file-review"
  });

  const WORK_CENTER_CAPABILITY = "hcn.work_center.read";
  const FILE_REVIEW_CAPABILITY = "hcn.file.review";
  const FILE_REF = /^subject_[a-f0-9]{32}$/;
  const SESSION_IDLE_HEADER = "x-hcn-session-idle-expires-at";
  const SESSION_ABSOLUTE_HEADER = "x-hcn-session-expires-at";
  const MAX_TIMER_DELAY_MS = 2_147_000_000;

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
      "recent-activities"
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

  async function postOperationalJson(url, body, signal) {
    if (!hasWorkCenterAuthority()) {
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

  function hasWorkCenterAuthority() {
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
      identity.role === "chance" &&
      sessionCapabilities().includes(WORK_CENTER_CAPABILITY)
    );
  }

  function hasFileReviewAuthority() {
    return (
      hasWorkCenterAuthority() &&
      sessionCapabilities().includes(FILE_REVIEW_CAPABILITY)
    );
  }

  function syncOperationalAccess() {
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
    state.workCenterController = null;
    state.fileController = null;
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
      const base = {
        category: kind,
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
        sessionNeedsSignIn ? "Bridge ready · sign in next" : "Read-only operations ready"
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
